import {
  finishingContainBackground,
  finishingProfiles,
  videoSpec,
  type FinishingFit,
  type FinishingProfile,
  type ManagedVideoSpec,
} from "@programmable-video/contracts";
import { parseCompositionProps } from "@programmable-video/composition-registry";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Writable } from "node:stream";
import { promisify } from "node:util";
import { z } from "zod";

import {
  openBrowserRenderer,
  openManagedBrowserRenderer,
  type FrameSource,
} from "./browser-renderer";
import type { JsonValue } from "./json-value";

const execFileAsync = promisify(execFile);
const maxFfmpegStderrBytes = 64 * 1024;
const ffprobeSchema = z.object({
  streams: z
    .array(
      z.object({
        codec_type: z.string().optional(),
        codec_name: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        avg_frame_rate: z.string().optional(),
        nb_frames: z.string().optional(),
        pix_fmt: z.string().optional(),
        duration: z.string().optional(),
        start_time: z.string().optional(),
      }),
    )
    .optional(),
  format: z
    .object({
      duration: z.string().optional(),
      start_time: z.string().optional(),
    })
    .optional(),
});

export interface OutputTransaction {
  outputPath: string;
  temporaryPath: string;
  commit: () => Promise<void>;
  discard: () => Promise<void>;
}

export interface RenderSystem {
  prepareOutput: (requestedOutputPath: string) => Promise<OutputTransaction>;
  spawnFfmpeg: (arguments_: readonly string[]) => ChildProcess;
}

export interface RenderVideoDependencies {
  system: RenderSystem;
  inspectOutput: (outputPath: string) => Promise<string>;
}

type ExecuteFile = (
  file: string,
  arguments_: readonly string[],
  options: { maxBuffer: number },
) => Promise<{ stdout: string }>;

export function createFfprobeOutputInspector(
  executeFile: ExecuteFile = execFileAsync,
): (outputPath: string) => Promise<string> {
  return async (outputPath) => {
    const { stdout } = await executeFile(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=index,codec_type,codec_name,width,height,avg_frame_rate,nb_frames,pix_fmt,duration,start_time:format=duration,start_time",
        "-of",
        "json",
        outputPath,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    return stdout;
  };
}

const nodeRenderSystem: RenderSystem = {
  prepareOutput: async (requestedOutputPath) => {
    const outputPath = resolve(requestedOutputPath);
    const temporaryPath = `${outputPath}.tmp-${randomUUID()}.mp4`;
    await mkdir(dirname(outputPath), { recursive: true });
    return {
      outputPath,
      temporaryPath,
      commit: () => rename(temporaryPath, outputPath),
      discard: () => unlink(temporaryPath).catch(() => undefined),
    };
  },
  spawnFfmpeg: (arguments_) =>
    spawn("ffmpeg", arguments_, { stdio: ["pipe", "ignore", "pipe"] }),
};

const defaultDependencies: RenderVideoDependencies = {
  system: nodeRenderSystem,
  inspectOutput: createFfprobeOutputInspector(),
};

export interface RenderVideoOptions {
  compositionId: string;
  props: JsonValue;
  outputPath: string;
  executablePath?: string;
}

export interface RenderFinishingOptions {
  startFrame: number;
  endFrame: number;
  profile: FinishingProfile;
  fit: FinishingFit;
  audio?: {
    path: string;
    gain: number;
  };
}

export interface RenderedVideo {
  outputPath: string;
  buildId: string;
  codec: "h264";
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

export async function renderVideo(
  options: RenderVideoOptions,
): Promise<RenderedVideo> {
  const { compositionId, props } = parseCompositionProps(
    options.compositionId,
    options.props,
  );
  const rendererOptions: Parameters<typeof openBrowserRenderer>[0] = {
    compositionId,
    props,
  };
  if (options.executablePath !== undefined) {
    rendererOptions.executablePath = options.executablePath;
  }
  return renderFrameSource(
    options.outputPath,
    () => openBrowserRenderer(rendererOptions),
    undefined,
  );
}

export async function renderManagedVideo(options: {
  staticRoot: string;
  commitSha: string;
  buildAttempt: number;
  inputDigest: string;
  outputPath: string;
  finishing?: RenderFinishingOptions;
  executablePath?: string;
}): Promise<RenderedVideo> {
  const rendererOptions: Parameters<typeof openManagedBrowserRenderer>[0] = {
    staticRoot: options.staticRoot,
    expectedIdentity: {
      commitSha: options.commitSha,
      buildAttempt: String(options.buildAttempt),
      inputDigest: options.inputDigest,
    },
  };
  if (options.executablePath !== undefined) {
    rendererOptions.executablePath = options.executablePath;
  }
  return renderFrameSource(
    options.outputPath,
    () => openManagedBrowserRenderer(rendererOptions),
    options.finishing,
  );
}

export async function renderFrameSource(
  requestedOutputPath: string,
  openRenderer: () => Promise<FrameSource>,
  finishing?: RenderFinishingOptions,
  dependencies: RenderVideoDependencies = defaultDependencies,
): Promise<RenderedVideo> {
  const output = await dependencies.system.prepareOutput(requestedOutputPath);

  let renderer: FrameSource | undefined;
  let ffmpeg: ChildProcess | undefined;
  let ffmpegFinished:
    Promise<{ code: number | null; error: Error | undefined }> | undefined;
  let completed = false;

  try {
    renderer = await openRenderer();

    const sourceSpec = renderer.spec;
    const plan = resolveRenderPlan(sourceSpec, finishing);
    const processState = startFfmpeg(
      output.temporaryPath,
      sourceSpec,
      plan,
      dependencies,
    );
    ffmpeg = processState.process;
    ffmpegFinished = processState.finished;

    for (let frame = plan.startFrame; frame < plan.endFrame; frame += 1) {
      const png = await renderer.captureFrame(frame);
      await writeWithBackpressure(processState.stdin, png);
    }

    processState.stdin.end();
    const result = await processState.finished;
    if (result.error !== undefined || result.code !== 0) {
      throw new Error(
        `ffmpeg failed${result.code === null ? "" : ` with exit code ${result.code}`}: ${result.error?.message ?? processState.stderr()}`,
      );
    }

    await validateVideo(output.temporaryPath, plan, dependencies.inspectOutput);
    await output.commit();
    completed = true;
    return {
      outputPath: output.outputPath,
      buildId: renderer.buildId,
      codec: "h264",
      width: plan.width,
      height: plan.height,
      fps: sourceSpec.fps,
      durationInFrames: plan.durationInFrames,
    };
  } finally {
    if (ffmpeg !== undefined && ffmpeg.exitCode === null) {
      ffmpeg.kill("SIGKILL");
    }
    await ffmpegFinished?.catch(() => undefined);
    await renderer?.close().catch(() => undefined);
    if (!completed) {
      await output.discard().catch(() => undefined);
    }
  }
}

interface RenderPlan extends RenderFinishingOptions {
  width: number;
  height: number;
  durationInFrames: number;
  expectedAudio: boolean;
}

const profileDimensions: Record<
  FinishingProfile,
  { width: number; height: number }
> = finishingProfiles;

function resolveRenderPlan(
  sourceSpec: ManagedVideoSpec,
  finishing: RenderFinishingOptions | undefined,
): RenderPlan {
  const selected = finishing ?? {
    startFrame: 0,
    endFrame: sourceSpec.durationInFrames,
    profile: "landscape",
    fit: "contain",
  };
  if (
    !Number.isInteger(selected.startFrame) ||
    !Number.isInteger(selected.endFrame) ||
    selected.startFrame < 0 ||
    selected.endFrame > sourceSpec.durationInFrames ||
    selected.startFrame >= selected.endFrame
  ) {
    throw new Error("Finishing trim must be a non-empty source frame range");
  }
  if (
    selected.audio !== undefined &&
    (!Number.isFinite(selected.audio.gain) ||
      selected.audio.gain < 0 ||
      selected.audio.gain > 1)
  ) {
    throw new Error("Audio gain must be between 0 and 1");
  }
  return {
    ...selected,
    ...profileDimensions[selected.profile],
    durationInFrames: selected.endFrame - selected.startFrame,
    expectedAudio: selected.audio !== undefined,
  };
}

export function buildVideoFilter(
  plan: Pick<RenderPlan, "width" | "height" | "fit">,
): string {
  const dimensions = `${plan.width}:${plan.height}`;
  if (plan.fit === "contain") {
    const background = finishingContainBackground.replace("#", "0x");
    return `scale=${dimensions}:force_original_aspect_ratio=decrease,pad=${dimensions}:(ow-iw)/2:(oh-ih)/2:color=${background},setsar=1`;
  }
  return `scale=${dimensions}:force_original_aspect_ratio=increase,crop=${dimensions}:(iw-ow)/2:(ih-oh)/2,setsar=1`;
}

function startFfmpeg(
  outputPath: string,
  sourceSpec: ManagedVideoSpec,
  plan: RenderPlan,
  dependencies: RenderVideoDependencies,
) {
  const durationSeconds = plan.durationInFrames / sourceSpec.fps;
  const audioArguments =
    plan.audio === undefined
      ? ["-an"]
      : [
          "-filter_complex",
          `[1:a:0]asetpts=PTS-STARTPTS,volume=${plan.audio.gain},apad,atrim=duration=${durationSeconds}[audio]`,
          "-map",
          "0:v:0",
          "-map",
          "[audio]",
          "-c:a",
          "aac",
          "-b:a",
          "192k",
        ];
  const process = dependencies.system.spawnFfmpeg([
    "-hide_banner",
    "-loglevel",
    "warning",
    "-f",
    "image2pipe",
    "-framerate",
    String(sourceSpec.fps),
    "-vcodec",
    "png",
    "-i",
    "pipe:0",
    ...(plan.audio === undefined ? [] : ["-i", plan.audio.path]),
    "-frames:v",
    String(plan.durationInFrames),
    "-vf",
    buildVideoFilter(plan),
    ...audioArguments,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(sourceSpec.fps),
    "-t",
    String(durationSeconds),
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    "-movflags",
    "+faststart",
    "-map_metadata",
    "-1",
    "-y",
    outputPath,
  ]);

  const stdin = process.stdin;
  const stderrStream = process.stderr;
  if (stdin === null || stderrStream === null) {
    process.kill("SIGKILL");
    throw new Error("ffmpeg did not expose piped input and error streams");
  }

  let stderr = Buffer.alloc(0);
  stderrStream.on("data", (chunk: Buffer) => {
    stderr = Buffer.concat([stderr, chunk]);
    if (stderr.length > maxFfmpegStderrBytes) {
      stderr = stderr.subarray(stderr.length - maxFfmpegStderrBytes);
    }
  });
  stdin.on("error", () => undefined);

  let spawnError: Error | undefined;
  process.on("error", (error: Error) => {
    spawnError = error;
  });
  const finished = new Promise<{
    code: number | null;
    error: Error | undefined;
  }>((resolvePromise) => {
    process.on("close", (code: number | null) =>
      resolvePromise({ code, error: spawnError }),
    );
  });

  return {
    process,
    stdin,
    finished,
    stderr: () => stderr.toString("utf8").trim() || "no ffmpeg diagnostics",
  };
}

function writeWithBackpressure(stream: Writable, chunk: Buffer): Promise<void> {
  if (stream.destroyed) {
    return Promise.reject(new Error("ffmpeg stdin closed before all frames"));
  }
  if (stream.write(chunk)) return Promise.resolve();

  return new Promise((resolvePromise, reject) => {
    const onDrain = () => {
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("ffmpeg stdin closed before draining"));
    };
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

async function validateVideo(
  outputPath: string,
  plan: RenderPlan,
  inspectOutput: RenderVideoDependencies["inspectOutput"],
): Promise<void> {
  const stdout = await inspectOutput(outputPath);
  const probe = ffprobeSchema.parse(JSON.parse(stdout));
  const stream = probe.streams?.find(
    (candidate) => candidate.codec_type === "video",
  );
  const audio = probe.streams?.find(
    (candidate) => candidate.codec_type === "audio",
  );
  const fps = parseFrameRate(stream?.avg_frame_rate);
  const expectedDuration = plan.durationInFrames / videoSpec.fps;
  const duration = Number(probe.format?.duration ?? stream?.duration);
  const audioDuration = Number(audio?.duration);
  const videoStartTime = Number(stream?.start_time);
  const audioStartTime = Number(audio?.start_time);
  const frameTolerance = 1 / videoSpec.fps;
  if (
    stream?.codec_name !== "h264" ||
    stream.width !== plan.width ||
    stream.height !== plan.height ||
    fps !== videoSpec.fps ||
    stream.pix_fmt !== "yuv420p" ||
    Number(stream.nb_frames) !== plan.durationInFrames ||
    !Number.isFinite(videoStartTime) ||
    Math.abs(videoStartTime) > frameTolerance ||
    !Number.isFinite(duration) ||
    Math.abs(duration - expectedDuration) > frameTolerance ||
    (plan.expectedAudio
      ? audio?.codec_name !== "aac" ||
        !Number.isFinite(audioDuration) ||
        !Number.isFinite(audioStartTime) ||
        Math.abs(audioStartTime) > frameTolerance ||
        Math.abs(audioDuration - expectedDuration) > frameTolerance
      : audio !== undefined)
  ) {
    throw new Error(
      `ffprobe rejected output: expected h264 ${plan.width}x${plan.height} at ${videoSpec.fps}fps with ${plan.durationInFrames} frames${plan.expectedAudio ? " and AAC audio" : " without audio"}`,
    );
  }
}

function parseFrameRate(frameRate: string | undefined): number | undefined {
  if (frameRate === undefined) return undefined;
  const [numerator, denominator] = frameRate.split("/").map(Number);
  if (
    numerator === undefined ||
    denominator === undefined ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return undefined;
  }
  return numerator / denominator;
}
