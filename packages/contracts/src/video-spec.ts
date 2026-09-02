import { z } from "zod";

export const videoSpec = {
  width: 1280,
  height: 720,
  fps: 30,
  durationInFrames: 360,
} as const;

export type VideoSpec = typeof videoSpec;

export const managedVideoFpsSchema = z.literal(videoSpec.fps);
export const managedVideoDurationInFramesSchema = z.union([
  z.literal(360),
  z.literal(450),
]);

export const managedVideoMaxDurationSeconds =
  Math.max(360, 450) / videoSpec.fps;

export const managedVideoSpecSchema = z
  .object({
    width: z.literal(videoSpec.width),
    height: z.literal(videoSpec.height),
    fps: managedVideoFpsSchema,
    durationInFrames: managedVideoDurationInFramesSchema,
  })
  .strict();

export type ManagedVideoSpec = z.infer<typeof managedVideoSpecSchema>;
