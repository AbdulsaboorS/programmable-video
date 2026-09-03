import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import { getRevisionSourceProvenance, type RevisionEnv } from "./revisions";

const owner = "creator@example.com";
const projectId = "0198c7d4-a5e6-7000-8000-000000000000";
const revisionId = "0198c7d4-a5e6-7000-8000-000000000001";
const commitSha = "a".repeat(40);

function environment(options: { ready?: boolean; provenance?: string } = {}) {
  const first = vi.fn(async (...values: unknown[]) =>
    options.ready === false || values[1] !== owner
      ? null
      : {
          revision_id: revisionId,
          commit_sha: commitSha,
          repository_name: "video-test",
          source_kind: options.provenance ? "r2-bundle" : "artifacts",
          source_provenance: options.provenance ?? null,
        },
  );
  const prepare = vi.fn(() => ({
    bind: (...values: unknown[]) => ({ first: () => first(...values) }),
  }));
  const database = fromPartial<D1Database>({ prepare });
  return {
    env: {
      ARTIFACTS_ACCOUNT_ID: "test-account",
      ARTIFACTS_API_TOKEN: "test-token",
      ARTIFACTS_NAMESPACE: "programmable-video",
      PROJECTS_DB: database,
    } satisfies RevisionEnv,
    first,
    prepare,
  };
}

describe("revision source provenance", () => {
  it("serves persisted provenance for a bundle revision without Artifacts", async () => {
    const markdown = `# Source Provenance

## Product Source

- Repository: local bundle
- Commit: ${commitSha}

## Reused Source

- Components: src/App.tsx
- Styles and fonts: src/styles.css
- Icons and assets: public/icon.svg

## Adaptations

- Uses deterministic fixtures.

## Remaining Visual Differences

- None`;
    const { env } = environment({ provenance: markdown });
    const fetcher = vi.fn<typeof fetch>();

    const response = await getRevisionSourceProvenance(
      projectId,
      revisionId,
      owner,
      env,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ markdown });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retrieves bounded evidence from the server-resolved exact commit", async () => {
    const { env, first, prepare } = environment();
    const markdown = `# Source Provenance

## Product Source

- Repository: https://gitlab.example.com/product
- Commit: ${"b".repeat(40)}

## Reused Source

- Components: src/Dashboard.tsx: Dashboard
- Styles and fonts: src/dashboard.css
- Icons and assets: src/icons/check.svg

## Adaptations

- Fixed demo data replaces API calls.

## Remaining Visual Differences

- None`;
    const fetcher = vi.fn<typeof fetch>(async () => new Response(markdown));

    const response = await getRevisionSourceProvenance(
      projectId,
      revisionId,
      owner,
      env,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      revisionId,
      commitSha,
      markdown,
    });
    expect(first).toHaveBeenCalledWith(projectId, owner, revisionId);
    expect(prepare).toHaveBeenCalledWith(
      expect.stringContaining("b.status = 'ready'"),
    );
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining(
        `/repos/video-test/file?ref=${commitSha}&path=SOURCE_PROVENANCE.md`,
      ),
      expect.objectContaining({
        headers: { authorization: "Bearer test-token" },
      }),
    );
  });

  it("does not read Artifacts for another owner or a non-ready revision", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const owned = environment();
    const pending = environment({ ready: false });

    const unownedResponse = await getRevisionSourceProvenance(
      projectId,
      revisionId,
      "other@example.com",
      owned.env,
      fetcher,
    );
    const pendingResponse = await getRevisionSourceProvenance(
      projectId,
      revisionId,
      owner,
      pending.env,
      fetcher,
    );

    expect(unownedResponse.status).toBe(404);
    expect(pendingResponse.status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [404, "Source provenance not found", 404],
    [500, "Source provenance is temporarily unavailable", 502],
  ])(
    "maps an Artifacts HTTP %i response to a controlled error",
    async (artifactsStatus, message, expectedStatus) => {
      const { env } = environment();
      const response = await getRevisionSourceProvenance(
        projectId,
        revisionId,
        owner,
        env,
        async () => new Response("failure", { status: artifactsStatus }),
      );

      expect(response.status).toBe(expectedStatus);
      expect(await response.json()).toEqual({ error: message });
    },
  );

  it("rejects oversized and blank provenance", async () => {
    const { env } = environment();
    const oversized = await getRevisionSourceProvenance(
      projectId,
      revisionId,
      owner,
      env,
      async () =>
        new Response("", { headers: { "content-length": "1048577" } }),
    );
    const blank = await getRevisionSourceProvenance(
      projectId,
      revisionId,
      owner,
      env,
      async () => new Response("   "),
    );

    expect(oversized.status).toBe(422);
    expect(blank.status).toBe(422);
    expect(await blank.json()).toEqual({
      error:
        "Source provenance is invalid or incomplete. Request changes so the agent completes every required section.",
    });
  });
});
