import {
  finishingAudioMaxBytes,
  finishingAudioMaxDurationMs,
  sha256Schema,
} from "@programmable-video/contracts";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import {
  retrievePrivateMedia,
  type PrivateMediaCapability,
} from "./retrieve-private-media";

const execFileAsync = promisify(execFile);
const audioDecodeTimeoutMs = 30_000;

const audioProbeOutputSchema = z
  .object({
    streams: z
      .array(
        z
          .object({
            index: z.number().int().optional(),
            codec_type: z.string().optional(),
            codec_name: z.string().optional(),
            duration: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    format: z
      .object({ duration: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const childProcessFailureSchema = z
  .object({
    code: z.union([z.string(), z.number()]).optional(),
    killed: z.boolean().optional(),
  })
  .passthrough();

type ChildProcessFailure = z.output<typeof childProcessFailureSchema>;

export const audioValidationRequestSchema = z
  .object({
    media: z
      .object({
        url: z.url(),
        token: z.string().min(32).max(4_096),
        sha256: sha256Schema,
        byteSize: z.number().int().positive().max(finishingAudioMaxBytes),
      })
      .strict(),
    maxDurationMs: z.number().int().positive().max(finishingAudioMaxDurationMs),
  })
  .strict();

export type AudioValidationResult =
  { valid: true; decodedDurationMs: number } | { valid: false; error: string };

interface AudioProbe {
  durationMs: number;
  streamIndex: number;
}

type AudioDecodeResult = "decoded" | "invalid" | "timeout";

interface AudioValidationDependencies {
  createTemporaryDirectory: () => Promise<string>;
  removeTemporaryDirectory: (path: string) => Promise<void>;
  retrieveMedia: (
    capability: PrivateMediaCapability,
    outputPath: string,
  ) => Promise<void>;
  inspectAudio: (path: string) => Promise<AudioProbe | null>;
  decodeAudio: (
    path: string,
    streamIndex: number,
  ) => Promise<AudioDecodeResult>;
}

const defaultDependencies: AudioValidationDependencies = {
  createTemporaryDirectory: () => mkdtemp(join(tmpdir(), "audio-validation-")),
  removeTemporaryDirectory: (path) =>
    rm(path, { recursive: true, force: true }),
  retrieveMedia: retrievePrivateMedia,
  inspectAudio,
  decodeAudio,
};

export async function validateAudio(
  request: z.infer<typeof audioValidationRequestSchema>,
  dependencies: AudioValidationDependencies = defaultDependencies,
): Promise<AudioValidationResult> {
  const temporaryDirectory = await dependencies.createTemporaryDirectory();
  try {
    const audioPath = join(temporaryDirectory, "private-audio-input");
    await dependencies.retrieveMedia(request.media, audioPath);
    const probe = await dependencies.inspectAudio(audioPath);
    if (probe === null) {
      return { valid: false, error: "No decodable audio stream found" };
    }
    if (!Number.isFinite(probe.durationMs) || probe.durationMs <= 0) {
      return {
        valid: false,
        error: "Audio duration must be greater than zero",
      };
    }
    if (probe.durationMs > request.maxDurationMs) {
      return { valid: false, error: "Audio exceeds maximum duration" };
    }
    const decodeResult = await dependencies.decodeAudio(
      audioPath,
      probe.streamIndex,
    );
    if (decodeResult === "timeout") {
      return { valid: false, error: "Audio decode timed out" };
    }
    if (decodeResult === "invalid") {
      return { valid: false, error: "Audio could not be fully decoded" };
    }
    return {
      valid: true,
      decodedDurationMs: Math.max(1, Math.round(probe.durationMs)),
    };
  } finally {
    await dependencies.removeTemporaryDirectory(temporaryDirectory);
  }
}

export async function inspectAudio(
  path: string,
  runProbe: (path: string) => Promise<string | null> = runFfprobe,
): Promise<AudioProbe | null> {
  const stdout = await runProbe(path);
  if (stdout === null) return null;
  const probe = audioProbeOutputSchema.parse(JSON.parse(stdout));
  const audio = probe.streams?.find(
    (stream) => stream.codec_type === "audio" && Boolean(stream.codec_name),
  );
  if (audio?.index === undefined) return null;
  const streamDuration = Number(audio.duration);
  return {
    durationMs:
      (Number.isFinite(streamDuration)
        ? streamDuration
        : Number(probe.format?.duration)) * 1_000,
    streamIndex: audio.index,
  };
}

export async function decodeAudio(
  path: string,
  streamIndex: number,
  runDecode: (
    path: string,
    streamIndex: number,
  ) => Promise<void> = runFfmpegDecode,
): Promise<AudioDecodeResult> {
  try {
    await runDecode(path, streamIndex);
    return "decoded";
  } catch (error) {
    const parsedFailure = childProcessFailureSchema.safeParse(error);
    if (!parsedFailure.success) throw error;
    if (isTimeoutError(parsedFailure.data)) return "timeout";
    if (Number.isInteger(parsedFailure.data.code)) return "invalid";
    throw error;
  }
}

async function runFfprobe(path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=index,codec_type,codec_name,duration:format=duration",
        "-of",
        "json",
        path,
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    return stdout;
  } catch (error) {
    const parsedFailure = childProcessFailureSchema.safeParse(error);
    if (parsedFailure.success && Number.isInteger(parsedFailure.data.code)) {
      return null;
    }
    throw error;
  }
}

async function runFfmpegDecode(
  path: string,
  streamIndex: number,
): Promise<void> {
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-xerror",
      "-i",
      path,
      "-map",
      `0:${streamIndex}`,
      "-f",
      "null",
      "-",
    ],
    { timeout: audioDecodeTimeoutMs, maxBuffer: 1024 * 1024 },
  );
}

function isTimeoutError(error: ChildProcessFailure): boolean {
  return error.code === "ETIMEDOUT" || error.killed === true;
}
