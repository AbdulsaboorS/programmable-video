// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  finishingContainBackground,
  finishingSpecVersion,
  type ManagedPublication,
} from "@programmable-video/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PublicationCard, PublicationHistory } from "./PublicationHistory";

function readyPublication(downloadReady: boolean): ManagedPublication {
  return {
    id: "0198c7d4-a5e6-7000-8000-000000000501",
    projectId: "0198c7d4-a5e6-7000-8000-000000000000",
    revisionId: "0198c7d4-a5e6-7000-8000-000000000103",
    buildAttempt: 1,
    manifestDigest: "a".repeat(64),
    inputDigest: "b".repeat(64),
    finishingSpecDigest: "c".repeat(64),
    finishingSpec: {
      version: finishingSpecVersion,
      trim: { startFrame: 12, endFrame: 300 },
      output: {
        profile: "portrait",
        width: 1080,
        height: 1920,
        fit: "cover",
        containBackground: finishingContainBackground,
      },
      audio: null,
      captions: { mode: "none" },
    },
    attempts: [
      {
        id: "0198c7d4-a5e6-7000-8000-000000000502",
        attempt: 1,
        status: "ready",
        error: null,
        streamVideoId: "stream-id",
        playback: {
          status: "ready",
          playerUrl: "about:blank",
          hlsUrl: "https://customer.example/video.m3u8",
          thumbnailUrl: null,
        },
        captions: { status: "failed", error: "Caption delivery failed" },
        download: downloadReady
          ? { status: "ready", url: "https://customer.example/video.mp4" }
          : { status: "processing", percentComplete: 50 },
        createdAt: "2026-08-26T12:00:00.000Z",
        updatedAt: "2026-08-26T12:01:00.000Z",
      },
    ],
    createdAt: "2026-08-26T12:00:00.000Z",
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PublicationCard", () => {
  it("shows independent delivery states and hides MP4 until ready", () => {
    render(
      <PublicationCard
        busy={false}
        canPublishAnother={true}
        projectName="Acme Dashboard"
        publication={readyPublication(false)}
        onRetry={vi.fn()}
        onPublishAnother={vi.fn()}
      />,
    );

    expect(screen.getByText("Playback: ready")).toBeDefined();
    expect(screen.getByText("Captions: failed")).toBeDefined();
    expect(screen.getByText("Download: processing (50%)")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Download MP4" })).toBeNull();
    const iframe = screen.getByTitle(/Acme Dashboard publication/);
    expect(iframe.parentElement?.getAttribute("style")).toContain(
      "1080 / 1920",
    );
    expect(iframe.getAttribute("allow")).toContain("fullscreen");
    expect(iframe.hasAttribute("allowfullscreen")).toBe(true);
    expect(screen.getByRole("link", { name: "Open player" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Retry publication" }),
    ).toBeDefined();
  });

  it("does not copy settings when the exact publication source is not selected", () => {
    const onPublishAnother = vi.fn();
    render(
      <PublicationHistory
        currentRevisionId="0198c7d4-a5e6-7000-8000-000000000999"
        projectName="Acme Dashboard"
        publications={[readyPublication(true)]}
        onRetry={vi.fn()}
        onPublishAnother={onPublishAnother}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Publish another version",
    });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Select approved source 0198c7d4/)).toBeDefined();
    fireEvent.click(button);
    expect(onPublishAnother).not.toHaveBeenCalled();
  });

  it("shows ready MP4 and reports clipboard success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <PublicationCard
        busy={false}
        canPublishAnother={true}
        projectName="Acme Dashboard"
        publication={readyPublication(true)}
        onRetry={vi.fn()}
        onPublishAnother={vi.fn()}
      />,
    );

    expect(screen.getByRole("link", { name: "Download MP4" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Copy share link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("about:blank"));
    expect(
      screen.getByRole("button", { name: "Share link copied" }),
    ).toBeDefined();
  });

  it("reports clipboard failure without hiding playback or download", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) },
    });
    render(
      <PublicationCard
        busy={false}
        canPublishAnother={true}
        projectName="Acme Dashboard"
        publication={readyPublication(true)}
        onRetry={vi.fn()}
        onPublishAnother={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy share link" }));
    expect(
      await screen.findByText("Could not copy the bearer share link."),
    ).toBeDefined();
    expect(screen.getByRole("link", { name: "Download MP4" })).toBeDefined();
  });
});
