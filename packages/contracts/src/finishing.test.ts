import { describe, expect, it } from "vitest";

import {
  createNoOpFinishingSpec,
  createPublicationRequestSchema,
  finishingProfiles,
  finishingSpecSchema,
  managedPublicationHistorySchema,
  projectMediaAssetSchema,
} from "./finishing";

const asset = {
  id: "0198c7d4-a5e6-7000-8000-000000000001",
  sha256: "a".repeat(64),
};

describe("finishing specification", () => {
  it.each([360, 450] as const)(
    "creates the version-1 full-duration no-op for %i frames",
    (durationInFrames) => {
      expect(
        finishingSpecSchema.parse(createNoOpFinishingSpec(durationInFrames)),
      ).toMatchObject({
        version: 1,
        trim: { startFrame: 0, endFrame: durationInFrames },
        output: {
          profile: "landscape",
          ...finishingProfiles.landscape,
          fit: "contain",
        },
        audio: null,
        captions: { mode: "none" },
      });
    },
  );

  it("accepts fixed output profiles and a half-open trim range", () => {
    const spec = createNoOpFinishingSpec(450);
    expect(
      finishingSpecSchema.safeParse({
        ...spec,
        trim: { startFrame: 30, endFrame: 450 },
        output: {
          ...spec.output,
          profile: "portrait",
          ...finishingProfiles.portrait,
          fit: "cover",
        },
      }).success,
    ).toBe(true);
  });

  it("rejects empty trim, arbitrary dimensions, and unknown fields", () => {
    const spec = createNoOpFinishingSpec(360);
    expect(
      finishingSpecSchema.safeParse({
        ...spec,
        trim: { startFrame: 10, endFrame: 10 },
      }).success,
    ).toBe(false);
    expect(
      finishingSpecSchema.safeParse({
        ...spec,
        output: { ...spec.output, width: 1920 },
      }).success,
    ).toBe(false);
    expect(finishingSpecSchema.safeParse({ ...spec, fade: true }).success).toBe(
      false,
    );
  });

  it("requires uploaded audio for generated captions", () => {
    const spec = createNoOpFinishingSpec(360);
    expect(
      finishingSpecSchema.safeParse({
        ...spec,
        captions: { mode: "generated", language: "en" },
      }).success,
    ).toBe(false);
    expect(
      finishingSpecSchema.safeParse({
        ...spec,
        audio: { asset, gainPercent: 75 },
        captions: { mode: "generated", language: "en" },
      }).success,
    ).toBe(true);
  });

  it("requires a bounded idempotency key on publication creation", () => {
    const request = {
      idempotencyKey: "publish:0198c7d4-a5e6-7000-8000-000000000001",
      finishingSpec: createNoOpFinishingSpec(360),
    };
    expect(createPublicationRequestSchema.parse(request)).toEqual(request);
    expect(
      createPublicationRequestSchema.safeParse({
        ...request,
        idempotencyKey: "contains spaces",
      }).success,
    ).toBe(false);
  });
});

describe("publication and media contracts", () => {
  it("keeps playback, caption, and download states independent", () => {
    const publication = {
      id: "0198c7d4-a5e6-7000-8000-000000000010",
      projectId: "0198c7d4-a5e6-7000-8000-000000000000",
      revisionId: "0198c7d4-a5e6-7000-8000-000000000002",
      buildAttempt: 1,
      manifestDigest: "b".repeat(64),
      inputDigest: "c".repeat(64),
      finishingSpec: createNoOpFinishingSpec(360),
      finishingSpecDigest: "d".repeat(64),
      attempts: [
        {
          id: "0198c7d4-a5e6-7000-8000-000000000011",
          attempt: 1,
          status: "ready",
          error: null,
          streamVideoId: "stream-id",
          playback: {
            status: "ready",
            playerUrl: "https://example.com/player",
            hlsUrl: "https://example.com/manifest.m3u8",
            thumbnailUrl: null,
          },
          captions: { status: "failed", error: "Caption processing failed" },
          download: { status: "processing", percentComplete: 40 },
          createdAt: "2026-08-26T10:00:00.000Z",
          updatedAt: "2026-08-26T10:01:00.000Z",
        },
      ],
      createdAt: "2026-08-26T10:00:00.000Z",
    } as const;

    expect(
      managedPublicationHistorySchema.parse({ publications: [publication] }),
    ).toEqual({ publications: [publication] });
  });

  it("bounds media metadata by asset kind", () => {
    const metadata = {
      ...asset,
      projectId: "0198c7d4-a5e6-7000-8000-000000000000",
      kind: "audio",
      fileName: "voice.mp3",
      mediaType: "audio/mpeg",
      byteSize: 1024,
      validationStatus: "valid",
      validationError: null,
      decodedDurationMs: 12_000,
      createdAt: "2026-08-26T10:00:00.000Z",
    } as const;
    expect(projectMediaAssetSchema.parse(metadata)).toEqual(metadata);
    expect(
      projectMediaAssetSchema.safeParse({
        ...metadata,
        decodedDurationMs: 60_001,
      }).success,
    ).toBe(false);
  });
});
