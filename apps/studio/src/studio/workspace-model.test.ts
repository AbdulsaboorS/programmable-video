import {
  finishingContainBackground,
  finishingSpecVersion,
  type ManagedPublication,
  type ProjectRevision,
} from "@programmable-video/contracts";
import { describe, expect, it } from "vitest";

import { deriveStudioWorkspace } from "./workspace-model";

const projectId = "0198c7d4-a5e6-7000-8000-000000000000";
const manifestDigest = "a".repeat(64);
const inputDigest = "b".repeat(64);

function revision(
  sequence: number,
  buildStatus: NonNullable<ProjectRevision["build"]>["status"] = "ready",
  overrides: Partial<ProjectRevision> = {},
): ProjectRevision {
  const time = `2026-08-20T${String(sequence).padStart(2, "0")}:00:00.000Z`;
  return {
    id: `0198c7d4-a5e6-7000-8000-${String(sequence).padStart(12, "0")}`,
    projectId,
    commitSha: sequence.toString(16).padStart(40, "0"),
    ref: "refs/heads/main",
    isDefaultBranch: true,
    inspectionVersion: 1,
    status: buildStatus === "ready" ? "valid" : "pending",
    findings: [],
    build: {
      status: buildStatus,
      attempt: 1,
      checks: [],
      manifestDigest: buildStatus === "ready" ? manifestDigest : null,
      inputDigest: buildStatus === "ready" ? inputDigest : null,
      startedAt: time,
      completedAt: buildStatus === "queued" ? null : time,
    },
    approval: null,
    latestRender: null,
    createdAt: time,
    updatedAt: time,
    ...overrides,
  };
}

function approved(source: ProjectRevision): ProjectRevision {
  return {
    ...source,
    approval: {
      approvedAt: source.updatedAt,
      manifestDigest,
      inputDigest,
      attempt: 1,
    },
  };
}

function publication(
  sequence: number,
  source: ProjectRevision,
  playback: "pending" | "ready" = "ready",
  overrides: Partial<ManagedPublication> = {},
): ManagedPublication {
  const time = `2026-08-21T${String(sequence).padStart(2, "0")}:00:00.000Z`;
  return {
    id: `0198c7d4-a5e6-7000-9000-${String(sequence).padStart(12, "0")}`,
    projectId,
    revisionId: source.id,
    buildAttempt: 1,
    manifestDigest,
    inputDigest,
    finishingSpecDigest: "c".repeat(64),
    finishingSpec: {
      version: finishingSpecVersion,
      trim: { startFrame: 0, endFrame: 360 },
      output: {
        profile: "landscape",
        width: 1280,
        height: 720,
        fit: "contain",
        containBackground: finishingContainBackground,
      },
      audio: null,
      captions: { mode: "none" },
    },
    attempts: [
      {
        id: `0198c7d4-a5e6-7000-a000-${String(sequence).padStart(12, "0")}`,
        attempt: 1,
        status: playback === "ready" ? "ready" : "rendering",
        error: null,
        streamVideoId: playback === "ready" ? `stream-${sequence}` : null,
        playback:
          playback === "ready"
            ? {
                status: "ready",
                playerUrl: `https://example.com/${sequence}/player`,
                hlsUrl: `https://example.com/${sequence}/index.m3u8`,
                thumbnailUrl: null,
              }
            : { status: "pending" },
        captions: { status: "not_requested" },
        download: { status: "not_requested" },
        createdAt: time,
        updatedAt: time,
      },
    ],
    createdAt: time,
    ...overrides,
  };
}

describe("deriveStudioWorkspace", () => {
  it("starts an empty workspace at Draft", () => {
    const model = deriveStudioWorkspace([], []);

    expect(model.recommendedStage).toBe("draft");
    expect(model.stages).toEqual({
      draft: { available: true, complete: false },
      review: { available: false, complete: false },
      finish: { available: false, complete: false },
      published: { available: false, complete: false },
    });
  });

  it.each(["queued", "error"] as const)(
    "retains an older ready draft while a newer revision is %s",
    (status) => {
      const ready = revision(1);
      const newer = revision(2, status);

      const model = deriveStudioWorkspace([ready, newer], []);

      expect(model.latestRevision).toBe(newer);
      expect(model.latestUsableDraft).toBe(ready);
      expect(model.newerRevisionActivity).toEqual([newer]);
      expect(model.recommendedStage).toBe("review");
    },
  );

  it("accepts only an approval for the exact ready build", () => {
    const source = revision(1, "ready", {
      approval: {
        approvedAt: "2026-08-20T02:00:00.000Z",
        manifestDigest,
        inputDigest,
        attempt: 2,
      },
    });

    expect(deriveStudioWorkspace([source], []).exactApproval).toBeUndefined();

    const model = deriveStudioWorkspace([approved(source)], []);
    expect(model.exactApproval).toEqual(approved(source).approval);
    expect(model.stages.review.complete).toBe(true);
    expect(model.stages.finish.available).toBe(true);
    expect(model.recommendedStage).toBe("finish");
  });

  it("recognizes exact-source publications and the newest playable output", () => {
    const source = approved(revision(1));
    const playable = publication(1, source);
    const newerPending = publication(2, source, "pending");

    const model = deriveStudioWorkspace([source], [playable, newerPending]);

    expect(model.hasCurrentSourcePublication).toBe(true);
    expect(model.newestPlayablePublication).toBe(playable);
    expect(model.stages.finish.complete).toBe(true);
    expect(model.stages.published).toEqual({ available: true, complete: true });
    expect(model.recommendedStage).toBe("published");
  });

  it("does not let an older publication advance a newer draft", () => {
    const olderSource = approved(revision(1));
    const olderPublication = publication(1, olderSource);
    const newerDraft = revision(2);

    const model = deriveStudioWorkspace(
      [olderSource, newerDraft],
      [olderPublication],
    );

    expect(model.latestUsableDraft).toBe(newerDraft);
    expect(model.exactApproval).toBeUndefined();
    expect(model.hasCurrentSourcePublication).toBe(false);
    expect(model.newestPlayablePublication).toBe(olderPublication);
    expect(model.stages.published.available).toBe(true);
    expect(model.recommendedStage).toBe("review");
  });

  it("matches publications to every exact approved-build field", () => {
    const source = approved(revision(1));
    const wrongArtifact = publication(1, source, "ready", {
      manifestDigest: "d".repeat(64),
    });

    const model = deriveStudioWorkspace([source], [wrongArtifact]);

    expect(model.hasCurrentSourcePublication).toBe(false);
    expect(model.recommendedStage).toBe("finish");
  });

  it("applies display limits only after deriving from complete histories", () => {
    const oldReady = approved(revision(1));
    const oldPlayable = publication(1, oldReady);
    const failed = revision(2, "error");
    const pendingPublication = publication(2, oldReady, "pending");

    const model = deriveStudioWorkspace(
      [oldReady, failed],
      [oldPlayable, pendingPublication],
      { revisions: 1, publications: 1 },
    );

    expect(model.displayRevisions).toEqual([failed]);
    expect(model.displayPublications).toEqual([pendingPublication]);
    expect(model.latestUsableDraft).toBe(oldReady);
    expect(model.newestPlayablePublication).toBe(oldPlayable);
    expect(model.hasCurrentSourcePublication).toBe(true);
  });
});
