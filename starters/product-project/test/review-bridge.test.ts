import { describe, expect, it } from "vitest";

import {
  clampReviewFrame,
  elapsedReviewFrame,
  parseReviewCommand,
  previewReviewSource,
  reviewProtocolVersion,
  reviewState,
  studioReviewSource,
} from "../src/review-bridge";

describe("review bridge", () => {
  it("preserves the version-1 Studio protocol identifiers", () => {
    expect(reviewProtocolVersion).toBe(1);
    expect(studioReviewSource).toBe("programmable-video-studio");
    expect(previewReviewSource).toBe("programmable-video-preview");
  });

  it("accepts only the versioned Studio command contract", () => {
    expect(
      parseReviewCommand({
        source: studioReviewSource,
        version: reviewProtocolVersion,
        type: "request-state",
        commandId: 1,
      }),
    ).toEqual({
      source: studioReviewSource,
      version: reviewProtocolVersion,
      type: "request-state",
      commandId: 1,
    });
    expect(
      parseReviewCommand({
        source: studioReviewSource,
        version: reviewProtocolVersion,
        type: "seek",
        commandId: 2,
        frame: 120,
      }),
    ).toEqual({
      source: studioReviewSource,
      version: reviewProtocolVersion,
      type: "seek",
      commandId: 2,
      frame: 120,
    });
    expect(
      parseReviewCommand({
        source: "other",
        version: reviewProtocolVersion,
        type: "play",
        commandId: 3,
      }),
    ).toBeNull();
    expect(
      parseReviewCommand({
        source: studioReviewSource,
        version: 2,
        type: "pause",
        commandId: 4,
      }),
    ).toBeNull();
  });

  it("clamps seeks and elapsed playback to the video timeline", () => {
    expect(clampReviewFrame(-10)).toBe(0);
    expect(clampReviewFrame(81.6)).toBe(82);
    expect(clampReviewFrame(900)).toBe(359);
    expect(elapsedReviewFrame(30, 1_500)).toBe(75);
    expect(elapsedReviewFrame(350, 1_000)).toBe(359);
    expect(elapsedReviewFrame(30, -1_000)).toBe(30);
  });

  it("publishes normalized frame state and the fixed video specification", () => {
    expect(reviewState(400, false, 12)).toEqual({
      source: previewReviewSource,
      version: reviewProtocolVersion,
      type: "state",
      acknowledgedCommandId: 12,
      frame: 359,
      playing: false,
      spec: {
        width: 1280,
        height: 720,
        fps: 30,
        durationInFrames: 360,
      },
    });
  });
});
