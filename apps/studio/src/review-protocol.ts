import { videoSpec } from "@programmable-video/contracts";
import { z } from "zod";

export const reviewProtocolVersion = 1 as const;
export const studioReviewSource = "programmable-video-studio" as const;
export const previewReviewSource = "programmable-video-preview" as const;

const reviewSpecSchema = z
  .object({
    width: z.literal(videoSpec.width),
    height: z.literal(videoSpec.height),
    fps: z.literal(videoSpec.fps),
    durationInFrames: z.number().int().min(1).max(450),
  })
  .strict();

const reviewStateSchema = z
  .object({
    source: z.literal(previewReviewSource),
    version: z.literal(reviewProtocolVersion),
    type: z.literal("state"),
    acknowledgedCommandId: z.number().int().nonnegative(),
    frame: z.number().int().nonnegative(),
    playing: z.boolean(),
    spec: reviewSpecSchema,
  })
  .strict()
  .refine((state) => state.frame < state.spec.durationInFrames);

export type ReviewState = z.infer<typeof reviewStateSchema>;
export type ReviewMessageData = z.infer<ReturnType<typeof z.json>>;

export function parseReviewState(value: ReviewMessageData): ReviewState | null {
  const parsed = reviewStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function reviewStateFromMessage(
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  expectedSource: MessageEventSource | null,
  expectedOrigin: string,
): ReviewState | null {
  if (event.source !== expectedSource || event.origin !== expectedOrigin) {
    return null;
  }
  return parseReviewState(event.data);
}

export function reviewCommand(
  command:
    | { type: "request-state" }
    | { type: "play" }
    | { type: "pause" }
    | { type: "seek"; frame: number },
  commandId: number,
) {
  return {
    source: studioReviewSource,
    version: reviewProtocolVersion,
    commandId,
    ...command,
  } as const;
}
