import { z } from "zod";

import { videoSpec } from "./story";

export const reviewProtocolVersion = 1 as const;
export const studioReviewSource = "programmable-video-studio" as const;
export const previewReviewSource = "programmable-video-preview" as const;

const reviewCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      source: z.literal(studioReviewSource),
      version: z.literal(reviewProtocolVersion),
      type: z.literal("request-state"),
      commandId: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      source: z.literal(studioReviewSource),
      version: z.literal(reviewProtocolVersion),
      type: z.literal("play"),
      commandId: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      source: z.literal(studioReviewSource),
      version: z.literal(reviewProtocolVersion),
      type: z.literal("pause"),
      commandId: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      source: z.literal(studioReviewSource),
      version: z.literal(reviewProtocolVersion),
      type: z.literal("seek"),
      commandId: z.number().int().positive(),
      frame: z.number().int(),
    })
    .strict(),
]);

export type ReviewCommand = z.infer<typeof reviewCommandSchema>;

export function parseReviewCommand<Input>(value: Input): ReviewCommand | null {
  const parsed = reviewCommandSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function clampReviewFrame(frame: number): number {
  return Math.max(
    0,
    Math.min(videoSpec.durationInFrames - 1, Math.round(frame)),
  );
}

export function elapsedReviewFrame(
  startFrame: number,
  elapsedMs: number,
): number {
  return clampReviewFrame(
    startFrame + Math.floor((Math.max(0, elapsedMs) * videoSpec.fps) / 1_000),
  );
}

export function reviewState(
  frame: number,
  playing: boolean,
  acknowledgedCommandId: number,
) {
  return {
    source: previewReviewSource,
    version: reviewProtocolVersion,
    type: "state" as const,
    acknowledgedCommandId,
    frame: clampReviewFrame(frame),
    playing,
    spec: videoSpec,
  };
}
