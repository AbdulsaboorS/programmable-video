// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  finishingContainBackground,
  finishingSpecVersion,
  type ManagedPublication,
} from "@programmable-video/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PublishedWorkspace } from "./workspace-presentation";

const projectId = "0198c7d4-a5e6-7000-8000-000000000000";

function publication(
  publicationNumber: number,
  playback: "pending" | "ready",
): ManagedPublication {
  const suffix = String(publicationNumber).padStart(12, "0");
  return {
    id: `0198c7d4-a5e6-7000-9000-${suffix}`,
    projectId,
    revisionId: `0198c7d4-a5e6-7000-8000-${suffix}`,
    buildAttempt: 1,
    manifestDigest: "a".repeat(64),
    inputDigest: "b".repeat(64),
    finishingSpecDigest: "c".repeat(64),
    finishingSpec: {
      version: finishingSpecVersion,
      trim: { startFrame: 0, endFrame: 360 },
      output:
        publicationNumber === 2
          ? {
              profile: "landscape",
              width: 1280,
              height: 720,
              fit: "contain",
              containBackground: finishingContainBackground,
            }
          : {
              profile: "portrait",
              width: 1080,
              height: 1920,
              fit: "contain",
              containBackground: finishingContainBackground,
            },
      audio: null,
      captions: { mode: "none" },
    },
    attempts: [
      {
        id: `0198c7d4-a5e6-7000-a000-${suffix}`,
        attempt: 1,
        status: playback === "ready" ? "ready" : "rendering",
        error: null,
        streamVideoId: playback === "ready" ? `stream-${suffix}` : null,
        playback:
          playback === "ready"
            ? {
                status: "ready",
                playerUrl: "about:blank",
                hlsUrl: "https://customer.example/older-video.m3u8",
                thumbnailUrl: null,
              }
            : { status: "pending" },
        captions: { status: "not_requested" },
        download:
          playback === "ready"
            ? {
                status: "ready",
                url: "https://customer.example/older-video.mp4",
              }
            : { status: "not_requested" },
        createdAt: `2026-08-26T12:00:0${publicationNumber}.000Z`,
        updatedAt: `2026-08-26T12:01:0${publicationNumber}.000Z`,
      },
    ],
    createdAt: `2026-08-26T11:00:0${publicationNumber}.000Z`,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PublishedWorkspace", () => {
  it("previews the latest playable output without attaching its delivery actions to the newest output", () => {
    const newest = publication(2, "pending");
    const olderPlayable = publication(1, "ready");
    const onPublishAnother = vi.fn();
    const { container } = render(
      <PublishedWorkspace
        projectName="Acme Dashboard"
        currentRevisionId={newest.revisionId}
        publications={[newest, olderPlayable]}
        loading={false}
        mobileView="controls"
        onRetry={vi.fn()}
        onPublishAnother={onPublishAnother}
      />,
    );

    const preview = screen.getByTitle("Acme Dashboard latest playable video");
    expect(preview.getAttribute("src")).toBe("about:blank");
    expect(screen.queryByTitle("Acme Dashboard newest video")).toBeNull();
    expect(
      screen.getByText(
        "Showing the latest playable video while the newest version is not yet playable.",
      ),
    ).toBeDefined();

    const newestControls = container.querySelector(".newest-publication");
    if (!(newestControls instanceof HTMLElement)) {
      throw new Error("Expected newest publication controls");
    }
    const controls = within(newestControls);
    expect(
      controls.getByRole("heading", { name: "Publishing video" }),
    ).toBeDefined();
    expect(controls.getByText("landscape")).toBeDefined();
    expect(controls.getByText("pending")).toBeDefined();
    expect(controls.getAllByText("not_requested")).toHaveLength(2);
    expect(
      controls.queryByRole("button", { name: "Copy share link" }),
    ).toBeNull();
    expect(controls.queryByRole("link", { name: "Open player" })).toBeNull();
    expect(controls.queryByRole("link", { name: "Download MP4" })).toBeNull();
    expect(newestControls?.textContent).not.toContain("about:blank");

    fireEvent.click(
      controls.getByRole("button", { name: "Publish another version" }),
    );
    expect(onPublishAnother).toHaveBeenCalledWith(newest);
  });
});
