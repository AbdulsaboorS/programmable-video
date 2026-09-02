import { describe, expect, it } from "vitest";

import { mapWorkflowStatus, withWorkflowFailure } from "./status";

describe("mapWorkflowStatus", () => {
  it.each(["running", "waiting"] as const)("maps %s to rendering", (status) => {
    expect(mapWorkflowStatus({ status })).toEqual({ status: "rendering" });
  });

  it("maps queued to queued", () => {
    expect(mapWorkflowStatus({ status: "queued" })).toEqual({
      status: "queued",
    });
  });

  it("returns a valid ready output", () => {
    const output = {
      status: "ready" as const,
      videoId: "video-id",
      previewUrl: "https://example.com/watch",
      hlsUrl: "https://example.com/video.m3u8",
      thumbnailUrl: "https://example.com/thumbnail.jpg",
    };
    expect(mapWorkflowStatus({ status: "complete", output })).toEqual(output);
  });

  it("returns the stage and message from a tagged workflow error", () => {
    expect(
      mapWorkflowStatus({
        status: "errored",
        error: {
          name: "Error",
          message: "[upload] Cloudflare Stream is not enabled",
        },
      }),
    ).toEqual({
      status: "failed",
      error: {
        stage: "upload",
        message: "Cloudflare Stream is not enabled",
      },
    });
  });

  it.each(["errored", "terminated", "unknown", "complete"] as const)(
    "maps unsafe %s results to a safe failure",
    (status) => {
      expect(mapWorkflowStatus({ status })).toEqual({
        status: "failed",
        error: { stage: "render", message: "Render failed" },
      });
    },
  );

  it("preserves a stage tagged by a nested operation", async () => {
    await expect(
      withWorkflowFailure("render", async () => {
        throw new Error("[upload] Stream upload failed with status 503");
      }),
    ).rejects.toThrow("[upload] Stream upload failed with status 503");
  });
});
