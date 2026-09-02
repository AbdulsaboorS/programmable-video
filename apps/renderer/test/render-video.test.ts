import {
  videoSpec,
  type ManagedVideoSpec,
} from "@programmable-video/contracts";
import { fromPartial } from "@total-typescript/shoehorn";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildVideoFilter,
  createFfprobeOutputInspector,
  renderFrameSource,
  type RenderVideoDependencies,
} from "../src/render-video";

class FakeFfmpegProcess extends EventEmitter {
  exitCode: number | null = null;
  stderr = new EventEmitter();
  stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
    final: (callback) => {
      this.exitCode = 0;
      queueMicrotask(() => this.emit("close", 0));
      callback();
    },
  });
  kill = vi.fn(() => {
    queueMicrotask(() => this.emit("close", null));
    return true;
  });
}

function fakeFfmpegProcess(): ChildProcess {
  return fromPartial<ChildProcess>(new FakeFfmpegProcess());
}

function renderer(spec: ManagedVideoSpec) {
  return {
    buildId: "managed-build",
    spec,
    captureFrame: vi.fn(async () => Buffer.from("png")),
    close: vi.fn(async () => undefined),
  };
}

function createRuntime() {
  const spawnArguments: string[][] = [];
  const spawnedProcesses: ChildProcess[] = [];
  const spawnFfmpeg = (args: readonly string[]) => {
    spawnArguments.push([...args]);
    const process = fakeFfmpegProcess();
    spawnedProcesses.push(process);
    return process;
  };
  const inspectOutput = vi.fn(async () =>
    JSON.stringify({
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 1280,
          height: 720,
          avg_frame_rate: "30/1",
          nb_frames: "450",
          pix_fmt: "yuv420p",
          start_time: "0.000000",
        },
      ],
      format: { duration: "15.000000" },
    }),
  );
  const commit = vi.fn(async () => undefined);
  const discard = vi.fn(async () => undefined);
  const dependencies: RenderVideoDependencies = {
    system: {
      prepareOutput: vi.fn(async (requestedOutputPath) => ({
        outputPath: requestedOutputPath,
        temporaryPath: `${requestedOutputPath}.temporary.mp4`,
        commit,
        discard,
      })),
      spawnFfmpeg,
    },
    inspectOutput,
  };
  return {
    commit,
    dependencies,
    discard,
    inspectOutput,
    spawnArguments,
    spawnedProcesses,
  };
}

let runtime: ReturnType<typeof createRuntime>;

beforeEach(() => {
  runtime = createRuntime();
});

describe("video rendering specifications", () => {
  it("renders and validates all 450 frames from a managed build", async () => {
    const managedSpec = { ...videoSpec, durationInFrames: 450 } as const;
    const managedRenderer = renderer(managedSpec);

    const result = await renderFrameSource(
      "/workspace/out/video.mp4",
      async () => managedRenderer,
      undefined,
      runtime.dependencies,
    );

    expect(managedRenderer.captureFrame).toHaveBeenCalledTimes(450);
    expect(managedRenderer.captureFrame).toHaveBeenNthCalledWith(1, 0);
    expect(managedRenderer.captureFrame).toHaveBeenLastCalledWith(449);
    const ffmpegArguments = runtime.spawnArguments[0] ?? [];
    expect(ffmpegArguments[ffmpegArguments.indexOf("-frames:v") + 1]).toBe(
      "450",
    );
    expect(result).toMatchObject({ durationInFrames: 450, fps: 30 });
    expect(runtime.inspectOutput).toHaveBeenCalledOnce();
    expect(runtime.commit).toHaveBeenCalledOnce();
    expect(runtime.discard).not.toHaveBeenCalled();
  });

  it("keeps trusted compositions at 360 frames", async () => {
    const trustedRenderer = renderer(videoSpec);
    runtime.inspectOutput.mockResolvedValue(
      JSON.stringify({
        streams: [
          {
            codec_type: "video",
            codec_name: "h264",
            width: 1280,
            height: 720,
            avg_frame_rate: "30/1",
            nb_frames: "360",
            pix_fmt: "yuv420p",
            start_time: "0.000000",
          },
        ],
        format: { duration: "12.000000" },
      }),
    );

    const result = await renderFrameSource(
      "/workspace/out/trusted.mp4",
      async () => trustedRenderer,
      undefined,
      runtime.dependencies,
    );

    expect(trustedRenderer.captureFrame).toHaveBeenCalledTimes(360);
    const ffmpegArguments = runtime.spawnArguments[0] ?? [];
    expect(ffmpegArguments[ffmpegArguments.indexOf("-frames:v") + 1]).toBe(
      "360",
    );
    expect(result.durationInFrames).toBe(360);
  });

  it("captures exactly the selected half-open frame range", async () => {
    const managedSpec = { ...videoSpec, durationInFrames: 450 } as const;
    const managedRenderer = renderer(managedSpec);
    runtime.inspectOutput.mockResolvedValue(
      JSON.stringify({
        streams: [
          {
            codec_type: "video",
            codec_name: "h264",
            width: 1080,
            height: 1920,
            avg_frame_rate: "30/1",
            nb_frames: "30",
            pix_fmt: "yuv420p",
            start_time: "0.000000",
          },
        ],
        format: { duration: "1.000000" },
      }),
    );

    const result = await renderFrameSource(
      "/workspace/out/portrait.mp4",
      async () => managedRenderer,
      {
        startFrame: 120,
        endFrame: 150,
        profile: "portrait",
        fit: "cover",
      },
      runtime.dependencies,
    );

    expect(managedRenderer.captureFrame).toHaveBeenCalledTimes(30);
    expect(managedRenderer.captureFrame).toHaveBeenNthCalledWith(1, 120);
    expect(managedRenderer.captureFrame).toHaveBeenLastCalledWith(149);
    expect(result).toMatchObject({
      width: 1080,
      height: 1920,
      durationInFrames: 30,
    });
    const args = runtime.spawnArguments[0] ?? [];
    expect(args[args.indexOf("-vf") + 1]).toBe(
      "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(iw-ow)/2:(ih-oh)/2,setsar=1",
    );
  });

  it("pads short audio, applies gain, trims output, and emits AAC", async () => {
    const managedRenderer = renderer(videoSpec);
    runtime.inspectOutput.mockResolvedValue(
      JSON.stringify({
        streams: [
          {
            codec_type: "video",
            codec_name: "h264",
            width: 1080,
            height: 1080,
            avg_frame_rate: "30/1",
            nb_frames: "60",
            pix_fmt: "yuv420p",
            start_time: "0.000000",
          },
          {
            codec_type: "audio",
            codec_name: "aac",
            duration: "2.000000",
            start_time: "0.000000",
          },
        ],
        format: { duration: "2.000000" },
      }),
    );

    await renderFrameSource(
      "/workspace/out/audio.mp4",
      async () => managedRenderer,
      {
        startFrame: 30,
        endFrame: 90,
        profile: "square",
        fit: "contain",
        audio: { path: "/private/audio.m4a", gain: 0.25 },
      },
      runtime.dependencies,
    );

    const args = runtime.spawnArguments[0] ?? [];
    expect(args).toContain("/private/audio.m4a");
    expect(args[args.indexOf("-filter_complex") + 1]).toBe(
      "[1:a:0]asetpts=PTS-STARTPTS,volume=0.25,apad,atrim=duration=2[audio]",
    );
    expect(args[args.indexOf("-c:a") + 1]).toBe("aac");
    expect(args[args.indexOf("-t") + 1]).toBe("2");
    expect(args).not.toContain("-stream_loop");
    expect(args).not.toContain("-shortest");
  });

  it("rejects output streams that do not start within one frame of zero", async () => {
    const managedRenderer = renderer(videoSpec);
    runtime.inspectOutput.mockResolvedValue(
      JSON.stringify({
        streams: [
          {
            codec_type: "video",
            codec_name: "h264",
            width: 1280,
            height: 720,
            avg_frame_rate: "30/1",
            nb_frames: "360",
            pix_fmt: "yuv420p",
            start_time: "0.100000",
          },
        ],
        format: { duration: "12.000000" },
      }),
    );

    await expect(
      renderFrameSource(
        "/workspace/out/non-zero-start.mp4",
        async () => managedRenderer,
        undefined,
        runtime.dependencies,
      ),
    ).rejects.toThrow("ffprobe rejected output");
    expect(runtime.discard).toHaveBeenCalledOnce();
    expect(managedRenderer.close).toHaveBeenCalledOnce();
  });

  it("kills ffmpeg, closes the frame source, and discards partial output on capture failure", async () => {
    const managedRenderer = renderer(videoSpec);
    managedRenderer.captureFrame.mockRejectedValueOnce(
      new Error("frame capture failed"),
    );

    await expect(
      renderFrameSource(
        "/workspace/out/failed.mp4",
        async () => managedRenderer,
        undefined,
        runtime.dependencies,
      ),
    ).rejects.toThrow("frame capture failed");

    expect(runtime.spawnedProcesses[0]?.kill).toHaveBeenCalledWith("SIGKILL");
    expect(managedRenderer.close).toHaveBeenCalledOnce();
    expect(runtime.discard).toHaveBeenCalledOnce();
  });
});

describe("FFprobe output inspection", () => {
  it("runs ffprobe with the complete output validation query", async () => {
    const executeFile = vi.fn(async () => ({ stdout: "probe-json" }));

    await expect(
      createFfprobeOutputInspector(executeFile)("/output/video.mp4"),
    ).resolves.toBe("probe-json");
    expect(executeFile).toHaveBeenCalledWith(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=index,codec_type,codec_name,width,height,avg_frame_rate,nb_frames,pix_fmt,duration,start_time:format=duration,start_time",
        "-of",
        "json",
        "/output/video.mp4",
      ],
      { maxBuffer: 1024 * 1024 },
    );
  });
});

describe("FFmpeg output geometry", () => {
  it("builds contain padding and center-weighted cover filters", () => {
    expect(
      buildVideoFilter({ width: 1080, height: 1080, fit: "contain" }),
    ).toBe(
      "scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=0x0b0d10,setsar=1",
    );
    expect(buildVideoFilter({ width: 1280, height: 720, fit: "cover" })).toBe(
      "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720:(iw-ow)/2:(ih-oh)/2,setsar=1",
    );
  });
});
