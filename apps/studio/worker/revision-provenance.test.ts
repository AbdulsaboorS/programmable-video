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
          source_provenance: options.provenance ?? null,
        },
  );
  const prepare = vi.fn(() => ({
    bind: (...values: unknown[]) => ({ first: () => first(...values) }),
  }));
  const database = fromPartial<D1Database>({ prepare });
  return {
    env: {
      PROJECTS_DB: database,
    } satisfies RevisionEnv,
  };
}

describe("revision source provenance", () => {
  it("serves persisted provenance for a bundle revision", async () => {
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
    const response = await getRevisionSourceProvenance(
      projectId,
      revisionId,
      owner,
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ markdown });
  });

  it("does not serve provenance for another owner or a non-ready revision", async () => {
    const owned = environment();
    const pending = environment({ ready: false });

    const unownedResponse = await getRevisionSourceProvenance(
      projectId,
      revisionId,
      "other@example.com",
      owned.env,
    );
    const pendingResponse = await getRevisionSourceProvenance(
      projectId,
      revisionId,
      owner,
      pending.env,
    );

    expect(unownedResponse.status).toBe(404);
    expect(pendingResponse.status).toBe(404);
  });

  it("rejects blank persisted provenance", async () => {
    const { env } = environment({ provenance: "   " });
    const blank = await getRevisionSourceProvenance(
      projectId,
      revisionId,
      owner,
      env,
    );

    expect(blank.status).toBe(422);
    expect(await blank.json()).toEqual({
      error:
        "Source provenance is invalid or incomplete. Request changes so the agent completes every required section.",
    });
  });
});
