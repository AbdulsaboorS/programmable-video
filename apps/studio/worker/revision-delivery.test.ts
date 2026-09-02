import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { approveRevision, createPreviewSession } from "./revision-delivery";

const owner = "creator@example.com";
const otherOwner = "other@example.com";
const projectId = "0198c7d4-a5e6-7000-8000-000000000000";
const revisionId = "0198c7d4-a5e6-7000-8000-000000000001";
const signingKey = "test-preview-signing-key";

interface ReadyRevision {
  project_id: string;
  revision_id: string;
  owner_email: string;
  commit_sha: string;
  status: "queued" | "ready";
  attempt: number;
  preview_prefix: string;
  manifest_digest: string;
  input_digest: string;
}

interface StoredApproval {
  build_attempt: number;
  manifest_digest: string;
  input_digest: string;
  approved_by: string;
  approved_at: string;
}

class FakeDatabase {
  revision: ReadyRevision = {
    project_id: projectId,
    revision_id: revisionId,
    owner_email: owner,
    commit_sha: "a".repeat(40),
    status: "ready",
    attempt: 2,
    preview_prefix: `projects/${projectId}/revisions/${revisionId}/2`,
    manifest_digest: "b".repeat(64),
    input_digest: "c".repeat(64),
  };
  approval?: StoredApproval;

  prepare(query: string) {
    const sql = query.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        first: async () => this.first(sql, values) ?? null,
        run: async () => this.run(sql, values),
      }),
    };
  }

  private first(sql: string, values: unknown[]) {
    if (sql.includes("FROM projects p")) {
      const [requestedProjectId, requestedOwner, requestedRevisionId] = values;
      const revision = this.revision;
      if (
        revision.project_id === requestedProjectId &&
        revision.owner_email === requestedOwner &&
        revision.revision_id === requestedRevisionId &&
        revision.status === "ready"
      ) {
        return revision;
      }
      return undefined;
    }
    if (sql.includes("FROM revision_approvals")) return this.approval;
    throw new Error(`Unexpected first query: ${sql}`);
  }

  private async run(sql: string, values: unknown[]) {
    if (!sql.startsWith("INSERT OR IGNORE INTO revision_approvals")) {
      throw new Error(`Unexpected run query: ${sql}`);
    }
    if (this.approval) return { success: true, meta: { changes: 0 } };
    const value = z
      .tuple([
        z.string(),
        z.number(),
        z.string(),
        z.string(),
        z.string(),
        z.string(),
      ])
      .parse(values);
    this.approval = {
      build_attempt: value[1],
      manifest_digest: value[2],
      input_digest: value[3],
      approved_by: value[4],
      approved_at: value[5],
    };
    return { success: true, meta: { changes: 1 } };
  }
}

async function body(response: Response) {
  return z
    .object({
      url: z.string().optional(),
      expiresAt: z.string().optional(),
      error: z.string().optional(),
      attempt: z.number().optional(),
      manifestDigest: z.string().optional(),
      inputDigest: z.string().optional(),
      approvedAt: z.string().optional(),
    })
    .parse(await response.json());
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

afterEach(() => vi.useRealTimers());

describe("revision delivery", () => {
  it("returns a signed launch URL for an owned ready revision", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const database = new FakeDatabase();
    const response = await createPreviewSession(
      projectId,
      revisionId,
      owner,
      {
        PREVIEW_ORIGIN: "https://preview.example",
        PREVIEW_SIGNING_KEY: signingKey,
        PROJECTS_DB: fromPartial<D1Database>(database),
      },
      "https://studio.example",
    );

    expect(response.status).toBe(201);
    const result = await body(response);
    const launchUrl = new URL(result.url ?? "");
    const token = launchUrl.searchParams.get("token") ?? "";
    const [payload, signature] = token.split(".");
    if (!payload || !signature) throw new Error("Expected a signed capability");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    expect(launchUrl.origin).toBe("https://preview.example");
    expect(launchUrl.pathname).toBe("/launch");
    await expect(
      crypto.subtle.verify(
        "HMAC",
        key,
        ownedBuffer(decodeBase64Url(signature)),
        new TextEncoder().encode(payload),
      ),
    ).resolves.toBe(true);
    expect(
      JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))),
    ).toMatchObject({
      projectId,
      revisionId,
      owner,
      attempt: 2,
      manifestDigest: "b".repeat(64),
      expiresAt: 1_787_227_500,
    });
    expect(result.expiresAt).toBe("2026-08-20T12:05:00.000Z");
  });

  it.each([
    ["the wrong owner", otherOwner, "ready"],
    ["a non-ready revision", owner, "queued"],
  ] as const)(
    "returns a safe 404 for %s",
    async (_case, requestedOwner, status) => {
      const database = new FakeDatabase();
      database.revision.status = status;

      const response = await createPreviewSession(
        projectId,
        revisionId,
        requestedOwner,
        {
          PREVIEW_ORIGIN: "https://preview.example",
          PREVIEW_SIGNING_KEY: signingKey,
          PROJECTS_DB: fromPartial<D1Database>(database),
        },
        "https://studio.example",
      );

      expect(response.status).toBe(404);
      expect(await body(response)).toEqual({
        error: "Product revision not found",
      });
    },
  );

  it("rejects an insecure or same-origin preview configuration", async () => {
    const database = new FakeDatabase();
    const response = await createPreviewSession(
      projectId,
      revisionId,
      owner,
      {
        PREVIEW_ORIGIN: "https://studio.example",
        PREVIEW_SIGNING_KEY: signingKey,
        PROJECTS_DB: fromPartial<D1Database>(database),
      },
      "https://studio.example",
    );

    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({
      error: "Preview service is not configured safely",
    });
  });

  it("keeps the first approval immutable and makes retries idempotent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const database = new FakeDatabase();
    const db = fromPartial<D1Database>(database);

    const denied = await approveRevision(projectId, revisionId, otherOwner, db);
    expect(denied.status).toBe(404);
    expect(database.approval).toBeUndefined();

    const first = await approveRevision(projectId, revisionId, owner, db);
    const firstBody = await body(first);
    database.revision.attempt = 3;
    database.revision.manifest_digest = "d".repeat(64);
    database.revision.input_digest = "e".repeat(64);
    vi.setSystemTime(new Date("2026-08-20T13:00:00.000Z"));
    const retry = await approveRevision(projectId, revisionId, owner, db);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(await body(retry)).toEqual(firstBody);
    expect(firstBody).toEqual({
      attempt: 2,
      manifestDigest: "b".repeat(64),
      inputDigest: "c".repeat(64),
      approvedAt: "2026-08-20T12:00:00.000Z",
    });
    expect(database.approval?.approved_by).toBe(owner);
  });
});
