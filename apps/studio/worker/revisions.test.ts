import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  finishRevisionInspection,
  inspectRevision,
  listProjectRevisions,
  loadPendingRevisionTarget,
  recordPushedRevision,
  type RevisionEnv,
  type RevisionTarget,
} from "./revisions";

const commitSha = "a".repeat(40);
const projectId = "0198c7d4-a5e6-7000-8000-000000000000";

interface PushedEvent {
  type: "cf.artifacts.repo.pushed";
  source: {
    type: "artifacts.repo";
    namespace: string;
    repoName: string;
  };
  payload: {
    ref: string;
    before: string;
    after: string;
    commits: never[];
    totalCommitsCount: number;
    commitsTruncated: boolean;
  };
  metadata: {
    accountId: string;
    eventSubscriptionId: string;
    eventSchemaVersion: number;
    eventTimestamp: string;
  };
}
type PushedEventOverrides = Partial<Pick<PushedEvent, "payload" | "source">>;

function pushedEvent(overrides: PushedEventOverrides = {}): PushedEvent {
  return {
    type: "cf.artifacts.repo.pushed",
    source: {
      type: "artifacts.repo",
      namespace: "programmable-video",
      repoName: "video-test",
    },
    payload: {
      ref: "refs/heads/main",
      before: "b".repeat(40),
      after: commitSha,
      commits: [],
      totalCommitsCount: 0,
      commitsTruncated: false,
    },
    metadata: {
      accountId: "c".repeat(32),
      eventSubscriptionId: "d".repeat(32),
      eventSchemaVersion: 1,
      eventTimestamp: "2026-08-20T12:00:00.000Z",
    },
    ...overrides,
  };
}

function recordingEnvironment(
  projectKind: "artifacts" | "local" = "artifacts",
) {
  let revision:
    | {
        id: string;
        project_id: string;
        commit_sha: string;
        ref: string;
        inspection_status: "pending";
        created_at: string;
        updated_at: string;
      }
    | undefined;
  const insertValues = z.tuple([
    z.string(),
    z.string(),
    z.string(),
    z.string(),
    z.unknown(),
    z.string(),
    z.string(),
  ]);
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      first: async () => {
        if (
          sql.includes("FROM projects") &&
          sql.includes("repository_name = ?")
        ) {
          if (
            projectKind === "local" &&
            sql.includes("authoring_source_kind = 'artifacts'")
          ) {
            return null;
          }
          return {
            id: projectId,
            repository_name: "video-test",
            repository_default_branch: "main",
            repository_remote_url: "https://example.com/video-test.git",
          };
        }
        if (sql.includes("FROM project_revisions")) {
          return revision
            ? {
                ...revision,
                is_default_branch: 1,
                inspection_version: 1,
                inspection_findings: "[]",
              }
            : null;
        }
        return null;
      },
      run: async () => {
        let changes = 0;
        if (sql.includes("INSERT OR IGNORE") && !revision) {
          const [
            id,
            storedProjectId,
            storedCommitSha,
            ref,
            ,
            createdAt,
            updatedAt,
          ] = insertValues.parse(values);
          revision = {
            id,
            project_id: storedProjectId,
            commit_sha: storedCommitSha,
            ref,
            inspection_status: "pending",
            created_at: createdAt,
            updated_at: updatedAt,
          };
          changes = 1;
        }
        return { success: true, meta: { changes } };
      },
    }),
  }));
  const database = fromPartial<D1Database>({ prepare });
  return {
    env: {
      ARTIFACTS_ACCOUNT_ID: "test-account",
      ARTIFACTS_API_TOKEN: "test-token",
      ARTIFACTS_NAMESPACE: "programmable-video",
      PROJECTS_DB: database,
    } satisfies RevisionEnv,
    getRevision: () => revision,
  };
}

const target: RevisionTarget = {
  id: "0198c7d4-a5e6-7000-8000-000000000001",
  projectId,
  commitSha,
  ref: "refs/heads/main",
  inspectionStatus: "pending",
  source: {
    kind: "artifacts",
    repositoryName: "video-test",
    repositoryRemoteUrl: "https://example.com/video-test.git",
  },
};

const validPackage = JSON.stringify({
  packageManager: "pnpm@11.9.0",
  scripts: {
    "format:check": "prettier --check .",
    typecheck: "tsc --noEmit",
    test: "vitest run",
    build: "vite build",
  },
});

describe("project revisions", () => {
  it("ignores Artifacts events for local-authoring projects", async () => {
    const { env } = recordingEnvironment("local");

    await expect(recordPushedRevision(pushedEvent(), env)).resolves.toEqual({
      kind: "ignored",
      reason: "unknown-repository",
    });
  });

  it("loads a pending bundle target with immutable source identity", async () => {
    const database = fromPartial<D1Database>({
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            id: target.id,
            project_id: projectId,
            commit_sha: commitSha,
            ref: "refs/heads/main",
            inspection_status: "pending",
            source_kind: "r2-bundle",
            source_bundle_key: "projects/project/revisions/source.bundle",
            source_bundle_digest: "b".repeat(64),
            source_bundle_size: 123,
            repository_name: "local-sentinel",
            repository_remote_url: "https://local.invalid/project",
          }),
        }),
      }),
    });

    await expect(
      loadPendingRevisionTarget(target.id, projectId, database),
    ).resolves.toMatchObject({
      ref: "refs/heads/main",
      source: {
        kind: "r2-bundle",
        bundleDigest: "b".repeat(64),
        bundleSize: 123,
      },
    });
  });

  it("does not list revisions owned by another user", async () => {
    let revisionQueryRan = false;
    const database = fromPartial<D1Database>({
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => null,
          all: async () => {
            revisionQueryRan = sql.includes("FROM project_revisions");
            return { results: [] };
          },
        }),
      }),
    });

    const response = await listProjectRevisions(
      projectId,
      "other@example.com",
      database,
    );

    expect(response.status).toBe(404);
    expect(revisionQueryRan).toBe(false);
  });

  it.each(["not-json", JSON.stringify({ legacy: true })])(
    "returns the controlled error for malformed stored findings: %s",
    async (inspectionFindings) => {
      const database = fromPartial<D1Database>({
        prepare: () => ({
          bind: () => ({
            first: async () => ({ id: projectId }),
            all: async () => ({
              results: [
                {
                  id: target.id,
                  project_id: projectId,
                  commit_sha: commitSha,
                  ref: "refs/heads/main",
                  is_default_branch: 1,
                  inspection_version: 1,
                  inspection_status: "invalid",
                  inspection_findings: inspectionFindings,
                  created_at: "2026-08-20T12:00:00.000Z",
                  updated_at: "2026-08-20T12:00:00.000Z",
                  build_status: null,
                  build_attempt: null,
                  check_results: null,
                  manifest_digest: null,
                  input_digest: null,
                  build_started_at: null,
                  build_completed_at: null,
                  approved_at: null,
                  approval_manifest_digest: null,
                  approval_input_digest: null,
                  approval_build_attempt: null,
                  render_id: null,
                  render_status: null,
                  stream_video_id: null,
                  preview_url: null,
                  hls_url: null,
                  thumbnail_url: null,
                  render_error_message: null,
                },
              ],
            }),
          }),
        }),
      });

      const response = await listProjectRevisions(
        projectId,
        "creator@example.com",
        database,
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Could not load project revisions",
      });
    },
  );

  it("records only the first concurrent inspection result", async () => {
    let pending = true;
    const database = fromPartial<D1Database>({
      prepare: () => ({
        bind: () => ({
          run: async () => {
            const changes = pending ? 1 : 0;
            pending = false;
            return { success: true, meta: { changes } };
          },
        }),
      }),
    });

    await expect(
      finishRevisionInspection(
        target.id,
        { status: "valid", findings: [] },
        database,
      ),
    ).resolves.toBe(true);
    await expect(
      finishRevisionInspection(
        target.id,
        { status: "invalid", findings: [] },
        database,
      ),
    ).resolves.toBe(false);
  });

  it("records a default-branch push idempotently", async () => {
    const { env, getRevision } = recordingEnvironment();
    const first = await recordPushedRevision(pushedEvent(), env);
    const second = await recordPushedRevision(pushedEvent(), env);

    expect(first.kind).toBe("pending");
    expect(second.kind).toBe("pending");
    expect(getRevision()?.commit_sha).toBe(commitSha);
  });

  it("records the direct Workflow event shape using its trigger timestamp", async () => {
    const { env, getRevision } = recordingEnvironment();
    const documented = pushedEvent();
    const { metadata: _metadata, ...event } = documented;

    await expect(
      recordPushedRevision(
        {
          ...event,
          id: "0198c7d4-a5e6-7000-8000-000000000000",
          source: {
            namespace: event.source.namespace,
            repoName: event.source.repoName,
          },
        },
        env,
        new Date("2026-08-20T12:00:00.000Z"),
      ),
    ).resolves.toMatchObject({ kind: "pending" });
    expect(getRevision()?.commit_sha).toBe(commitSha);
    expect(getRevision()?.created_at).toBe("2026-08-20T12:00:00.000Z");
    expect(getRevision()?.updated_at).toBe("2026-08-20T12:00:00.000Z");
  });

  it("ignores branch deletions and pushes outside the managed namespace", async () => {
    const { env, getRevision } = recordingEnvironment();
    const deletion = pushedEvent({
      payload: { ...pushedEvent().payload, after: "0".repeat(40) },
    });
    const otherNamespace = pushedEvent({
      source: { ...pushedEvent().source, namespace: "other" },
    });

    await expect(recordPushedRevision(deletion, env)).resolves.toEqual({
      kind: "ignored",
      reason: "branch-deletion",
    });
    await expect(recordPushedRevision(otherNamespace, env)).resolves.toEqual({
      kind: "ignored",
      reason: "namespace-mismatch",
    });
    expect(getRevision()).toBeUndefined();
  });

  it("rejects a missing managed namespace instead of silently ignoring pushes", async () => {
    const { env } = recordingEnvironment();

    await expect(
      recordPushedRevision(pushedEvent(), {
        ...env,
        ARTIFACTS_NAMESPACE: "",
      }),
    ).rejects.toThrow("ARTIFACTS_NAMESPACE is required");
  });

  it("rejects a missing Artifacts account instead of recording an unusable revision", async () => {
    const { env } = recordingEnvironment();

    await expect(
      recordPushedRevision(pushedEvent(), {
        ...env,
        ARTIFACTS_ACCOUNT_ID: "",
      }),
    ).rejects.toThrow("ARTIFACTS_ACCOUNT_ID is required");
  });

  it("ignores non-branch refs emitted by Artifacts", async () => {
    const { env, getRevision } = recordingEnvironment();
    const note = pushedEvent({
      payload: { ...pushedEvent().payload, ref: "refs/notes/ai" },
    });

    await expect(recordPushedRevision(note, env)).resolves.toEqual({
      kind: "ignored",
      reason: "non-default-ref",
    });
    expect(getRevision()).toBeUndefined();
  });

  it("accepts framework-neutral projects at the exact commit", async () => {
    const { env } = recordingEnvironment();
    const requested: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/commit/")) return Response.json({ result: {} });
      if (url.includes("path=package.json")) return new Response(validPackage);
      return new Response("source");
    };

    await expect(inspectRevision(target, env, fetcher)).resolves.toEqual({
      status: "valid",
      findings: [],
    });
    expect(requested.every((url) => url.includes(commitSha))).toBe(true);
    expect(requested.some((url) => url.includes("ProductComposition"))).toBe(
      false,
    );
  });

  it("does not accept an aggregate verification script in place of managed checks", async () => {
    const { env } = recordingEnvironment();
    const aggregateOnlyPackage = JSON.stringify({
      packageManager: "pnpm@11.9.0",
      scripts: {
        verify:
          "pnpm format:check && pnpm typecheck && pnpm test && pnpm build",
      },
    });
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/commit/")) return Response.json({ result: {} });
      if (url.includes("path=package.json")) {
        return new Response(aggregateOnlyPackage);
      }
      return new Response("source");
    };

    const result = await inspectRevision(target, env, fetcher);

    expect(result.status).toBe("invalid");
    expect(result.findings).toHaveLength(4);
    expect(
      result.findings.every(
        (finding) => finding.code === "package.missing-script",
      ),
    ).toBe(true);
  });

  it("distinguishes invalid structure from platform failure", async () => {
    const { env } = recordingEnvironment();
    const missingFile: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/commit/")) return Response.json({ result: {} });
      if (url.includes("path=package.json")) return new Response(validPackage);
      return new Response("missing", { status: 404 });
    };
    const unavailable: typeof fetch = async () =>
      new Response("unavailable", { status: 503 });

    const invalid = await inspectRevision(target, env, missingFile);
    expect(invalid.status).toBe("invalid");
    expect(invalid.findings).toHaveLength(6);
    expect(invalid.findings).toContainEqual(
      expect.objectContaining({ path: "SOURCE_PROVENANCE.md" }),
    );
    await expect(inspectRevision(target, env, unavailable)).rejects.toThrow(
      "HTTP 503",
    );
  });
});
