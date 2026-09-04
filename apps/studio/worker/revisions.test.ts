import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import {
  finishRevisionInspection,
  inspectRevisionStructure,
  listProjectRevisions,
  loadPendingRevisionTarget,
  type RevisionTarget,
} from "./revisions";

const commitSha = "a".repeat(40);
const projectId = "0198c7d4-a5e6-7000-8000-000000000000";

const target: RevisionTarget = {
  id: "0198c7d4-a5e6-7000-8000-000000000001",
  projectId,
  commitSha,
  ref: "refs/heads/main",
  inspectionStatus: "pending",
  bundleKey: "projects/project/revisions/source.bundle",
  bundleDigest: "b".repeat(64),
  bundleSize: 123,
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
            source_bundle_key: "projects/project/revisions/source.bundle",
            source_bundle_digest: "b".repeat(64),
            source_bundle_size: 123,
          }),
        }),
      }),
    });

    await expect(
      loadPendingRevisionTarget(target.id, projectId, database),
    ).resolves.toMatchObject({
      ref: "refs/heads/main",
      bundleDigest: "b".repeat(64),
      bundleSize: 123,
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

  it("accepts framework-neutral project structure", async () => {
    await expect(
      inspectRevisionStructure(async (path) =>
        path === "package.json" ? validPackage : "source",
      ),
    ).resolves.toEqual({
      status: "valid",
      findings: [],
    });
  });

  it("does not accept an aggregate verification script in place of managed checks", async () => {
    const aggregateOnlyPackage = JSON.stringify({
      packageManager: "pnpm@11.9.0",
      scripts: {
        verify:
          "pnpm format:check && pnpm typecheck && pnpm test && pnpm build",
      },
    });
    const result = await inspectRevisionStructure(async (path) =>
      path === "package.json" ? aggregateOnlyPackage : "source",
    );

    expect(result.status).toBe("invalid");
    expect(result.findings).toHaveLength(4);
    expect(
      result.findings.every(
        (finding) => finding.code === "package.missing-script",
      ),
    ).toBe(true);
  });
});
