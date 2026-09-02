import { z } from "zod";

import { isoTimestampSchema, sha256Schema } from "./shared";
import { videoSpec } from "./video-spec";

export const finishingSpecVersion = 1 as const;
export const finishingContainBackground = "#0b0d10" as const;
export const finishingProfiles = {
  landscape: { width: videoSpec.width, height: videoSpec.height },
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1920 },
} as const;
export const finishingAudioMaxBytes = 25 * 1024 * 1024;
export const finishingAudioMaxDurationMs = 60_000;
export const finishingCaptionMaxBytes = 1024 * 1024;

const assetReferenceSchema = z
  .object({ id: z.uuid(), sha256: sha256Schema })
  .strict();

export const finishingProfileSchema = z.enum([
  "landscape",
  "square",
  "portrait",
]);
export const finishingFitSchema = z.enum(["contain", "cover"]);

export const finishingOutputSchema = z.discriminatedUnion("profile", [
  z
    .object({
      profile: z.literal("landscape"),
      width: z.literal(finishingProfiles.landscape.width),
      height: z.literal(finishingProfiles.landscape.height),
      fit: finishingFitSchema,
      containBackground: z.literal(finishingContainBackground),
    })
    .strict(),
  z
    .object({
      profile: z.literal("square"),
      width: z.literal(finishingProfiles.square.width),
      height: z.literal(finishingProfiles.square.height),
      fit: finishingFitSchema,
      containBackground: z.literal(finishingContainBackground),
    })
    .strict(),
  z
    .object({
      profile: z.literal("portrait"),
      width: z.literal(finishingProfiles.portrait.width),
      height: z.literal(finishingProfiles.portrait.height),
      fit: finishingFitSchema,
      containBackground: z.literal(finishingContainBackground),
    })
    .strict(),
]);

export const finishingTrimSchema = z
  .object({
    startFrame: z.number().int().nonnegative().max(449),
    endFrame: z.number().int().positive().max(450),
  })
  .strict()
  .refine(({ startFrame, endFrame }) => startFrame < endFrame, {
    message: "Trim must be a non-empty half-open frame range",
    path: ["endFrame"],
  });

export const finishingAudioSchema = z
  .object({
    asset: assetReferenceSchema,
    gainPercent: z.number().int().min(0).max(100),
  })
  .strict();

export const finishingCaptionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z
    .object({
      mode: z.literal("uploaded"),
      language: z.literal("en"),
      asset: assetReferenceSchema,
    })
    .strict(),
  z
    .object({ mode: z.literal("generated"), language: z.literal("en") })
    .strict(),
]);

export const finishingSpecSchema = z
  .object({
    version: z.literal(finishingSpecVersion),
    trim: finishingTrimSchema,
    output: finishingOutputSchema,
    audio: finishingAudioSchema.nullable(),
    captions: finishingCaptionSchema,
  })
  .strict()
  .superRefine((spec, context) => {
    if (spec.captions.mode === "generated" && spec.audio === null) {
      context.addIssue({
        code: "custom",
        message: "Generated captions require an audio asset",
        path: ["captions"],
      });
    }
  });

export function createNoOpFinishingSpec(
  durationInFrames: 360 | 450,
): FinishingSpec {
  return {
    version: finishingSpecVersion,
    trim: { startFrame: 0, endFrame: durationInFrames },
    output: {
      profile: "landscape",
      ...finishingProfiles.landscape,
      fit: "contain",
      containBackground: finishingContainBackground,
    },
    audio: null,
    captions: { mode: "none" },
  };
}

export const publicationIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const createPublicationRequestSchema = z
  .object({
    idempotencyKey: publicationIdempotencyKeySchema,
    finishingSpec: finishingSpecSchema,
  })
  .strict();

export const publicationStatusSchema = z.enum([
  "queued",
  "rendering",
  "ready",
  "failed",
]);
export const publicationAttemptStatusSchema = publicationStatusSchema;

export const playbackStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z.object({ status: z.literal("processing") }).strict(),
  z
    .object({
      status: z.literal("ready"),
      playerUrl: z.url(),
      hlsUrl: z.url(),
      thumbnailUrl: z.url().nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      error: z.string().min(1).max(1_000),
    })
    .strict(),
]);

export const captionStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_requested") }).strict(),
  z.object({ status: z.literal("pending") }).strict(),
  z.object({ status: z.literal("processing") }).strict(),
  z.object({ status: z.literal("ready"), language: z.literal("en") }).strict(),
  z
    .object({
      status: z.literal("failed"),
      error: z.string().min(1).max(1_000),
    })
    .strict(),
]);

export const downloadStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_requested") }).strict(),
  z.object({ status: z.literal("pending") }).strict(),
  z
    .object({
      status: z.literal("processing"),
      percentComplete: z.number().min(0).max(100).nullable(),
    })
    .strict(),
  z.object({ status: z.literal("ready"), url: z.url() }).strict(),
  z
    .object({
      status: z.literal("failed"),
      error: z.string().min(1).max(1_000),
    })
    .strict(),
]);

export const publicationAttemptSchema = z
  .object({
    id: z.uuid(),
    attempt: z.number().int().positive().max(1_000),
    status: publicationAttemptStatusSchema,
    error: z.string().min(1).max(1_000).nullable(),
    streamVideoId: z.string().min(1).max(255).nullable(),
    playback: playbackStatusSchema,
    captions: captionStatusSchema,
    download: downloadStatusSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const managedPublicationSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    revisionId: z.uuid(),
    buildAttempt: z.number().int().positive().max(1_000),
    manifestDigest: sha256Schema,
    inputDigest: sha256Schema,
    finishingSpec: finishingSpecSchema,
    finishingSpecDigest: sha256Schema,
    attempts: z.array(publicationAttemptSchema).min(1).max(1_000),
    createdAt: isoTimestampSchema,
  })
  .strict();

export const managedPublicationHistorySchema = z
  .object({ publications: z.array(managedPublicationSchema).max(1_000) })
  .strict();

export const mediaAssetValidationStatusSchema = z.enum([
  "pending",
  "valid",
  "invalid",
]);

const mediaMetadata = {
  id: z.uuid(),
  projectId: z.uuid(),
  fileName: z.string().min(1).max(255),
  byteSize: z.number().int().positive(),
  sha256: sha256Schema,
  validationStatus: mediaAssetValidationStatusSchema,
  validationError: z.string().min(1).max(1_000).nullable(),
  createdAt: isoTimestampSchema,
} as const;

export const projectMediaAssetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...mediaMetadata,
      kind: z.literal("audio"),
      mediaType: z.enum(["audio/mpeg", "audio/wav", "audio/mp4"]),
      byteSize: mediaMetadata.byteSize.max(finishingAudioMaxBytes),
      decodedDurationMs: z
        .number()
        .int()
        .positive()
        .max(finishingAudioMaxDurationMs)
        .nullable(),
    })
    .strict(),
  z
    .object({
      ...mediaMetadata,
      kind: z.literal("captions"),
      mediaType: z.literal("text/vtt"),
      byteSize: mediaMetadata.byteSize.max(finishingCaptionMaxBytes),
      language: z.literal("en"),
    })
    .strict(),
]);

export type FinishingProfile = z.infer<typeof finishingProfileSchema>;
export type FinishingFit = z.infer<typeof finishingFitSchema>;
export type FinishingSpec = z.infer<typeof finishingSpecSchema>;
export type CreatePublicationRequest = z.infer<
  typeof createPublicationRequestSchema
>;
export type PublicationAttempt = z.infer<typeof publicationAttemptSchema>;
export type ManagedPublication = z.infer<typeof managedPublicationSchema>;
export type ProjectMediaAsset = z.infer<typeof projectMediaAssetSchema>;
