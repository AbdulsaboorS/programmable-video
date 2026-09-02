import { createNoOpFinishingSpec } from "@programmable-video/contracts";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";

import { deliverCaptions, deliverDownload } from "./publication-delivery";
import type { PublicationWorkflowTarget } from "./managed-publications";

function target(): PublicationWorkflowTarget {
  return {
    attemptId: "0198c7d4-a5e6-7000-8000-000000000030",
    publicationId: "0198c7d4-a5e6-7000-8000-000000000031",
    projectId: "0198c7d4-a5e6-7000-8000-000000000000",
    revisionId: "0198c7d4-a5e6-7000-8000-000000000001",
    ownerEmail: "creator@example.com",
    commitSha: "f".repeat(40),
    projectName: "Launch",
    buildAttempt: 1,
    manifestDigest: "a".repeat(64),
    inputDigest: "b".repeat(64),
    previewPrefix: "preview",
    finishingSpec: createNoOpFinishingSpec(360),
    streamVideoId: "stream-video",
    streamUploadUrl: null,
    playbackStatus: "ready",
    playerUrl: "https://example.com/player",
    hlsUrl: "https://example.com/video.m3u8",
    thumbnailUrl: null,
    captionStatus: "pending",
    downloadStatus: "pending",
  };
}

function workflowStep() {
  return {
    do: vi.fn(async <T>(_name: string, callback: () => Promise<T>) =>
      callback(),
    ),
    sleep: vi.fn(async () => undefined),
  };
}

describe("publication delivery", () => {
  it("polls an existing uploaded caption until Stream marks it ready", async () => {
    const publication = target();
    publication.finishingSpec.captions = {
      mode: "uploaded",
      language: "en",
      asset: {
        id: "0198c7d4-a5e6-7000-8000-000000000040",
        sha256: "c".repeat(64),
      },
    };
    const list = vi
      .fn()
      .mockResolvedValueOnce([
        {
          language: "en",
          label: "English",
          generated: false,
          status: "inprogress",
        },
      ])
      .mockResolvedValueOnce([
        {
          language: "en",
          label: "English",
          generated: false,
          status: "inprogress",
        },
      ])
      .mockResolvedValueOnce([
        { language: "en", label: "English", generated: false, status: "ready" },
      ]);
    const upload = vi.fn();
    const step = workflowStep();
    const env = fromPartial<Env>({
      PROJECTS_DB: {
        prepare: vi.fn(() => ({
          bind: () => ({ run: async () => ({ success: true }) }),
        })),
      },
      STREAM: {
        video: () => ({ captions: { list, upload, delete: vi.fn() } }),
      },
    });

    await deliverCaptions(
      publication,
      "stream-video",
      fromPartial<WorkflowStep>(step),
      env,
    );

    expect(upload).not.toHaveBeenCalled();
    expect(step.sleep).toHaveBeenCalledOnce();
  });

  it("deletes and regenerates a failed default download", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        default: { status: "error", percentComplete: 0 },
      })
      .mockResolvedValueOnce({
        default: {
          status: "ready",
          percentComplete: 100,
          url: "https://example.com/video.mp4",
        },
      });
    const remove = vi.fn(async () => undefined);
    const generate = vi.fn(async () => ({}));
    const step = workflowStep();
    const env = fromPartial<Env>({
      PROJECTS_DB: {
        prepare: vi.fn(() => ({
          bind: () => ({ run: async () => ({ success: true }) }),
        })),
      },
      STREAM: {
        video: () => ({ downloads: { get, delete: remove, generate } }),
      },
    });

    await deliverDownload(
      target(),
      "stream-video",
      fromPartial<WorkflowStep>(step),
      env,
    );

    expect(remove).toHaveBeenCalledWith("default");
    expect(generate).toHaveBeenCalledWith("default");
  });
});
