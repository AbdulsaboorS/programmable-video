import {
  finishingAudioMaxBytes,
  finishingAudioMaxDurationMs,
} from "@programmable-video/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  audioValidationRequestSchema,
  decodeAudio,
  inspectAudio,
  validateAudio,
} from "../src/validate-audio";

const request = audioValidationRequestSchema.parse({
  media: {
    url: "https://studio.example.test/private-audio",
    token: "t".repeat(32),
    sha256: "a".repeat(64),
    byteSize: 1_024,
  },
  maxDurationMs: finishingAudioMaxDurationMs,
});

function dependencies(durationMs: number | null) {
  return {
    createTemporaryDirectory: vi.fn(async () => "/tmp/audio-validation-test"),
    removeTemporaryDirectory: vi.fn(async () => undefined),
    retrieveMedia: vi.fn(async () => undefined),
    inspectAudio: vi.fn(async () =>
      durationMs === null ? null : { durationMs, streamIndex: 1 },
    ),
    decodeAudio: vi.fn(
      async (): Promise<"decoded" | "invalid" | "timeout"> => "decoded",
    ),
  };
}

describe("audio validation request", () => {
  it("is strict and bounded", () => {
    expect(
      audioValidationRequestSchema.safeParse({ ...request, extra: true })
        .success,
    ).toBe(false);
    expect(
      audioValidationRequestSchema.safeParse({
        ...request,
        media: { ...request.media, byteSize: finishingAudioMaxBytes + 1 },
      }).success,
    ).toBe(false);
    expect(
      audioValidationRequestSchema.safeParse({
        ...request,
        maxDurationMs: finishingAudioMaxDurationMs + 1,
      }).success,
    ).toBe(false);
  });
});

describe("audio validation", () => {
  it("retrieves private media, returns decoded duration, and cleans up", async () => {
    const deps = dependencies(12_345.4);

    await expect(validateAudio(request, deps)).resolves.toEqual({
      valid: true,
      decodedDurationMs: 12_345,
    });
    expect(deps.retrieveMedia).toHaveBeenCalledWith(
      request.media,
      "/tmp/audio-validation-test/private-audio-input",
    );
    expect(deps.inspectAudio).toHaveBeenCalledWith(
      "/tmp/audio-validation-test/private-audio-input",
    );
    expect(deps.decodeAudio).toHaveBeenCalledWith(
      "/tmp/audio-validation-test/private-audio-input",
      1,
    );
    expect(deps.removeTemporaryDirectory).toHaveBeenCalledWith(
      "/tmp/audio-validation-test",
    );
  });

  it.each([
    [null, "No decodable audio stream found"],
    [0, "Audio duration must be greater than zero"],
    [finishingAudioMaxDurationMs + 0.1, "Audio exceeds maximum duration"],
  ] as const)(
    "rejects invalid decoded duration %s",
    async (duration, error) => {
      await expect(
        validateAudio(request, dependencies(duration)),
      ).resolves.toEqual({ valid: false, error });
    },
  );

  it("treats retrieval failures as server failures and still cleans up", async () => {
    const deps = dependencies(1_000);
    deps.retrieveMedia.mockRejectedValue(new Error("capability unavailable"));

    await expect(validateAudio(request, deps)).rejects.toThrow(
      "capability unavailable",
    );
    expect(deps.inspectAudio).not.toHaveBeenCalled();
    expect(deps.removeTemporaryDirectory).toHaveBeenCalledOnce();
  });

  it("treats ffprobe platform failures as server failures", async () => {
    const deps = dependencies(1_000);
    deps.inspectAudio.mockRejectedValue(new Error("ffprobe is unavailable"));

    await expect(validateAudio(request, deps)).rejects.toThrow(
      "ffprobe is unavailable",
    );
    expect(deps.removeTemporaryDirectory).toHaveBeenCalledOnce();
  });

  it.each([
    ["invalid", "Audio could not be fully decoded"],
    ["timeout", "Audio decode timed out"],
  ] as const)("rejects a full decode result of %s", async (result, error) => {
    const deps = dependencies(1_000);
    deps.decodeAudio.mockResolvedValue(result);

    await expect(validateAudio(request, deps)).resolves.toEqual({
      valid: false,
      error,
    });
    expect(deps.removeTemporaryDirectory).toHaveBeenCalledOnce();
  });
});

describe("audio probing", () => {
  it("requires an audio codec and uses its decoded duration", async () => {
    const runProbe = vi.fn(async () =>
      JSON.stringify({
        streams: [
          { index: 0, codec_type: "video", codec_name: "h264", duration: "9" },
          {
            index: 2,
            codec_type: "audio",
            codec_name: "aac",
            duration: "1.25",
          },
        ],
        format: { duration: "2" },
      }),
    );
    await expect(inspectAudio("/private/audio", runProbe)).resolves.toEqual({
      durationMs: 1_250,
      streamIndex: 2,
    });
    await expect(
      inspectAudio("/private/audio", async () =>
        JSON.stringify({
          streams: [{ index: 0, codec_type: "video", codec_name: "h264" }],
        }),
      ),
    ).resolves.toBeNull();
  });

  it("uses container duration when the audio stream omits duration", async () => {
    await expect(
      inspectAudio("/private/audio", async () =>
        JSON.stringify({
          streams: [{ index: 1, codec_type: "audio", codec_name: "mp3" }],
          format: { duration: "3.5" },
        }),
      ),
    ).resolves.toEqual({ durationMs: 3_500, streamIndex: 1 });
  });

  it("rejects corrupt probe output without an indexed audio stream", async () => {
    await expect(
      inspectAudio("/private/audio", async () =>
        JSON.stringify({
          streams: [{ codec_type: "audio", codec_name: "aac", duration: "1" }],
        }),
      ),
    ).resolves.toBeNull();
  });
});

describe("full audio decoding", () => {
  it("reports ffmpeg decode failures and timeout failures", async () => {
    await expect(
      decodeAudio("/private/audio", 1, async () => {
        throw Object.assign(new Error("corrupt packet"), { code: 1 });
      }),
    ).resolves.toBe("invalid");
    await expect(
      decodeAudio("/private/audio", 1, async () => {
        throw Object.assign(new Error("timed out"), { killed: true });
      }),
    ).resolves.toBe("timeout");
  });
});
