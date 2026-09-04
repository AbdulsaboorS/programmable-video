import { createHash } from "node:crypto";

import { fromPartial } from "@total-typescript/shoehorn";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { submitRevisionBundle, type RevisionSubmissionEnv } from "./revisions";

const projectId = "0198c7d4-a5e6-7000-8000-000000000000";
const owner = "creator@example.com";
const commitSha = "a".repeat(40);
const ref = "refs/heads/main";
const bundle = new TextEncoder().encode("test git bundle bytes");
const digest = createHash("sha256").update(bundle).digest("hex");

beforeAll(() => {
  Object.defineProperty(globalThis, "FixedLengthStream", {
    configurable: true,
    value: class extends TransformStream<Uint8Array, Uint8Array> {
      constructor(_size: number) {
        super();
      }
    },
  });
});

interface StoredRevision {
  id: string;
  project_id: string;
  commit_sha: string;
  ref: string;
  source_bundle_key: string;
  source_bundle_digest: string;
  source_bundle_size: number;
}

function environment(options: { owner?: string } = {}) {
  const revisions: StoredRevision[] = [];
  const objects = new Map<string, R2ObjectBody>();
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      first: async () => {
        if (sql.includes("FROM projects WHERE id")) {
          return values[1] === (options.owner ?? owner)
            ? {
                id: projectId,
                default_branch: "main",
              }
            : null;
        }
        if (sql.includes("FROM project_revisions")) {
          return (
            revisions.find(
              (revision) =>
                revision.project_id === values[0] &&
                revision.commit_sha === values[1],
            ) ?? null
          );
        }
        return null;
      },
      run: async () => {
        if (sql.includes("INSERT OR IGNORE INTO project_revisions")) {
          const [
            id,
            storedProjectId,
            sha,
            storedRef,
            ,
            key,
            storedDigest,
            size,
          ] = z
            .tuple([
              z.string(),
              z.string(),
              z.string(),
              z.string(),
              z.number(),
              z.string(),
              z.string(),
              z.number(),
              z.string(),
              z.string(),
            ])
            .parse(values);
          if (!revisions.some((revision) => revision.commit_sha === sha)) {
            revisions.push({
              id,
              project_id: storedProjectId,
              commit_sha: sha,
              ref: storedRef,
              source_bundle_key: key,
              source_bundle_digest: storedDigest,
              source_bundle_size: size,
            });
          }
        }
        return { success: true, meta: { changes: 1 } };
      },
    }),
  }));
  const put = vi.fn(
    async (key: string, value: ReadableStream, putOptions: R2PutOptions) => {
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      const object = fromPartial<R2ObjectBody>({
        key,
        size: bytes.byteLength,
        body: new Blob([bytes]).stream(),
        httpMetadata:
          putOptions.httpMetadata instanceof Headers
            ? {}
            : (putOptions.httpMetadata ?? {}),
        customMetadata: putOptions.customMetadata ?? {},
        checksums: fromPartial<R2Checksums>({
          sha256: Uint8Array.from(Buffer.from(digest, "hex")).buffer,
        }),
      });
      objects.set(key, object);
      return object;
    },
  );
  const existingWorkflowIds = new Set<string>();
  const createBatch = vi.fn(async (requests: Array<{ id: string }>) => {
    const created = requests.filter(({ id }) => !existingWorkflowIds.has(id));
    for (const { id } of created) existingWorkflowIds.add(id);
    return created.map(({ id }) => fromPartial<WorkflowInstance>({ id }));
  });
  const env = fromPartial<RevisionSubmissionEnv>({
    PROJECTS_DB: fromPartial<D1Database>({ prepare }),
    REVISION_SOURCES: fromPartial<R2Bucket>({
      put,
      head: async (key: string) => objects.get(key) ?? null,
      get: async (key: string) => objects.get(key) ?? null,
      delete: async (key: string | string[]) => {
        for (const item of Array.isArray(key) ? key : [key])
          objects.delete(item);
      },
    }),
    REVISION_WORKFLOW: fromPartial<RevisionSubmissionEnv["REVISION_WORKFLOW"]>({
      createBatch,
      get: async (id: string) => {
        if (!existingWorkflowIds.has(id)) {
          return fromPartial<WorkflowInstance>({
            id,
            status: async () => {
              throw new Error("missing workflow instance");
            },
          });
        }
        return fromPartial<WorkflowInstance>({
          id,
          status: async () => ({ status: "running" }),
          restart: async () => undefined,
        });
      },
    }),
  });
  return { env, revisions, objects, put, createBatch };
}

function request(bytes = bundle, headers: Record<string, string> = {}) {
  return new Request(
    `https://studio.example/api/projects/${projectId}/revisions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-git-bundle",
        "content-length": String(bytes.byteLength),
        "x-video-commit-sha": commitSha,
        "x-video-ref": ref,
        "x-video-bundle-sha256": digest,
        ...headers,
      },
      body: bytes,
    },
  );
}

describe("local revision bundle submission", () => {
  it("stores, records, dispatches, and replays the same identity idempotently", async () => {
    const { env, revisions, put, createBatch } = environment();

    const accepted = await submitRevisionBundle(
      request(),
      projectId,
      owner,
      env,
    );
    const replay = await submitRevisionBundle(request(), projectId, owner, env);

    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      status: "accepted",
      commitSha,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ status: "already-submitted" });
    expect(revisions).toHaveLength(1);
    expect(put).toHaveBeenCalledTimes(2);
    expect(createBatch).toHaveBeenCalledTimes(2);
  });

  it("rejects an unowned project before storing", async () => {
    const unowned = environment();

    expect(
      (
        await submitRevisionBundle(
          request(),
          projectId,
          "other@example.com",
          unowned.env,
        )
      ).status,
    ).toBe(404);
    expect(unowned.put).not.toHaveBeenCalled();
  });

  it("rejects revisions from a non-default branch before storing", async () => {
    const { env, revisions, put } = environment();
    const response = await submitRevisionBundle(
      request(bundle, { "x-video-ref": "refs/heads/feature" }),
      projectId,
      owner,
      env,
    );

    expect(response.status).toBe(409);
    expect(revisions).toHaveLength(0);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects a digest mismatch without recording an object or revision", async () => {
    const { env, revisions, objects } = environment();
    const response = await submitRevisionBundle(
      request(bundle, { "x-video-bundle-sha256": "0".repeat(64) }),
      projectId,
      owner,
      env,
    );

    expect(response.status).toBe(422);
    expect(revisions).toHaveLength(0);
    expect(objects.size).toBe(0);
  });

  it("restores a missing bundle object on idempotent resubmission", async () => {
    const { env, revisions, objects, put } = environment();
    expect(
      (await submitRevisionBundle(request(), projectId, owner, env)).status,
    ).toBe(202);
    objects.clear();

    const restored = await submitRevisionBundle(
      request(),
      projectId,
      owner,
      env,
    );

    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({
      status: "already-submitted",
    });
    expect(revisions).toHaveLength(1);
    expect(objects.size).toBe(1);
    expect(put).toHaveBeenCalledTimes(4);
  });

  it("keeps the persisted source recoverable when workflow dispatch fails", async () => {
    const { env, revisions, objects, createBatch } = environment();
    createBatch.mockRejectedValueOnce(new Error("workflow unavailable"));

    const response = await submitRevisionBundle(
      request(),
      projectId,
      owner,
      env,
    );

    expect(response.status).toBe(503);
    expect(revisions).toHaveLength(1);
    expect(objects.size).toBe(1);
  });

  it("reports an existing Workflow status failure instead of silently succeeding", async () => {
    const { env, revisions, objects } = environment();
    expect(
      (await submitRevisionBundle(request(), projectId, owner, env)).status,
    ).toBe(202);
    vi.spyOn(env.REVISION_WORKFLOW, "get").mockResolvedValueOnce(
      fromPartial<WorkflowInstance>({
        status: async () => {
          throw new Error("workflow status unavailable");
        },
      }),
    );

    const response = await submitRevisionBundle(
      request(),
      projectId,
      owner,
      env,
    );

    expect(response.status).toBe(503);
    expect(revisions).toHaveLength(1);
    expect(objects.size).toBe(1);
  });

  it("reports an existing Workflow restart failure instead of silently succeeding", async () => {
    const { env, revisions, objects } = environment();
    expect(
      (await submitRevisionBundle(request(), projectId, owner, env)).status,
    ).toBe(202);
    vi.spyOn(env.REVISION_WORKFLOW, "get").mockResolvedValueOnce(
      fromPartial<WorkflowInstance>({
        status: async () => ({ status: "errored" }),
        restart: async () => {
          throw new Error("workflow restart unavailable");
        },
      }),
    );

    const response = await submitRevisionBundle(
      request(),
      projectId,
      owner,
      env,
    );

    expect(response.status).toBe(503);
    expect(revisions).toHaveLength(1);
    expect(objects.size).toBe(1);
  });
});
