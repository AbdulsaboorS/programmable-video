import { compositionManifests } from "@programmable-video/composition-registry";
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  runVideoCommand,
  type CommandDependencies,
} from "../src/video-command";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

const listOutputSchema = z.object({
  version: z.literal(1),
  ok: z.literal(true),
  command: z.literal("list"),
  data: z.object({
    compositions: z.array(
      z
        .object({ id: z.string(), spec: z.object({}).passthrough() })
        .passthrough(),
    ),
  }),
});

function createHarness(overrides: Partial<CommandDependencies> = {}) {
  let stdout = "";
  let stderr = "";
  const captureStill: CommandDependencies["captureStill"] = vi.fn(
    async (options) => ({
      outputPath: options.outputPath,
      buildId: "build-test",
      frame: options.frame,
      format: "png" as const,
      width: 1280,
      height: 720,
    }),
  );
  const renderVideo: CommandDependencies["renderVideo"] = vi.fn(
    async (options) => ({
      outputPath: options.outputPath,
      buildId: "build-test",
      codec: "h264" as const,
      width: 1280,
      height: 720,
      fps: 30,
      durationInFrames: 360,
    }),
  );
  const dependencies: CommandDependencies = {
    readFile: vi.fn(async () => "{}"),
    captureStill,
    renderVideo,
    cwd: "/workspace",
    ...overrides,
  };

  return {
    run: (args: string[]) =>
      runVideoCommand(
        args,
        {
          stdout: (value) => {
            stdout += value;
          },
          stderr: (value) => {
            stderr += value;
          },
        },
        dependencies,
      ),
    output: () => ({ stdout, stderr }),
    captureStill,
    renderVideo,
  };
}

describe("video command", () => {
  it("writes exactly one versioned list envelope to stdout", async () => {
    const harness = createHarness();

    expect(await harness.run(["list", "--json"])).toBe(0);
    const { stdout, stderr } = harness.output();
    expect(stderr).toBe("");
    expect(stdout.endsWith("\n")).toBe(true);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    const result = listOutputSchema.parse(JSON.parse(stdout));
    expect(result).toMatchObject({
      version: 1,
      ok: true,
      command: "list",
    });
    expect(
      result.data.compositions.map(({ id, spec }) => ({ id, spec })),
    ).toEqual(compositionManifests.map(({ id, spec }) => ({ id, spec })));
  });

  it("uses defaults and returns normalized validated props", async () => {
    const harness = createHarness();

    expect(await harness.run(["validate", "support-agent", "--json"])).toBe(0);
    expect(JSON.parse(harness.output().stdout)).toMatchObject({
      version: 1,
      ok: true,
      command: "validate",
      data: {
        compositionId: "support-agent",
        props: { customerName: "Mara", companyName: "Northstar Labs" },
      },
    });
  });

  it("strictly validates a JSON props file", async () => {
    const harness = createHarness({
      readFile: vi.fn(async () =>
        JSON.stringify({
          customerName: "  Ada  ",
          companyName: "Docs",
          hostname: "docs.example",
          location: "London",
          issue: "Launch review",
        }),
      ),
    });

    expect(
      await harness.run([
        "validate",
        "support-agent",
        "--props",
        "props.json",
        "--json",
      ]),
    ).toBe(0);
    expect(JSON.parse(harness.output().stdout).data.props.customerName).toBe(
      "Ada",
    );
  });

  it.each([
    {
      args: ["validate", "missing", "--json"],
      code: "UNKNOWN_COMPOSITION",
      exitCode: 1,
    },
    {
      args: ["still", "support-agent", "--frame", "360", "--json"],
      code: "INVALID_FRAME",
      exitCode: 1,
    },
    {
      args: ["still", "support-agent", "--json"],
      code: "INVALID_USAGE",
      exitCode: 2,
    },
    {
      args: ["unknown", "--json"],
      code: "INVALID_USAGE",
      exitCode: 2,
    },
  ])("returns $code with the specified exit code", async (testCase) => {
    const harness = createHarness();

    expect(await harness.run(testCase.args)).toBe(testCase.exitCode);
    const { stdout, stderr } = harness.output();
    expect(JSON.parse(stdout)).toMatchObject({
      version: 1,
      ok: false,
      command: testCase.args[0],
      error: { code: testCase.code },
    });
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(stderr).not.toBe("");
  });

  it("distinguishes invalid JSON from props file I/O failures", async () => {
    const invalidJson = createHarness({
      readFile: vi.fn(async () => "not json"),
    });
    expect(
      await invalidJson.run([
        "validate",
        "support-agent",
        "--props",
        "bad.json",
        "--json",
      ]),
    ).toBe(1);
    expect(JSON.parse(invalidJson.output().stdout).error.code).toBe(
      "INVALID_PROPS",
    );

    const ioFailure = createHarness({
      readFile: vi.fn(async () => {
        throw Object.assign(new Error("file not found"), { code: "ENOENT" });
      }),
    });
    expect(
      await ioFailure.run([
        "validate",
        "support-agent",
        "--props",
        "missing.json",
        "--json",
      ]),
    ).toBe(1);
    expect(JSON.parse(ioFailure.output().stdout).error.code).toBe("IO_FAILURE");
  });

  it("captures a still at an absolute default path with metadata", async () => {
    const harness = createHarness();

    expect(
      await harness.run(["still", "support-agent", "--frame", "75", "--json"]),
    ).toBe(0);
    expect(harness.captureStill).toHaveBeenCalledWith(
      expect.objectContaining({
        compositionId: "support-agent",
        frame: 75,
        outputPath: "/workspace/out/support-agent-frame-75.png",
      }),
    );
    expect(JSON.parse(harness.output().stdout).data.artifact).toMatchObject({
      outputPath: "/workspace/out/support-agent-frame-75.png",
      frame: 75,
      format: "png",
      width: 1280,
      height: 720,
    });
  });

  it("returns render metadata and maps execution failures", async () => {
    const harness = createHarness();
    expect(await harness.run(["render", "support-agent", "--json"])).toBe(0);
    expect(JSON.parse(harness.output().stdout).data.artifact).toMatchObject({
      outputPath: "/workspace/out/support-agent.mp4",
      codec: "h264",
      fps: 30,
      durationInFrames: 360,
    });

    const failure = createHarness({
      renderVideo: vi.fn(async () => {
        throw new Error("ffmpeg failed");
      }),
    });
    expect(await failure.run(["render", "support-agent", "--json"])).toBe(1);
    expect(JSON.parse(failure.output().stdout).error.code).toBe(
      "RENDER_FAILURE",
    );
  });

  it("keeps usage failures off human-readable stdout", async () => {
    const harness = createHarness();

    expect(await harness.run(["list", "extra"])).toBe(2);
    expect(harness.output().stdout).toBe("");
    expect(harness.output().stderr).toContain("Usage:");
  });
});

describe("root pnpm video command", () => {
  it("preserves a single JSON failure envelope and exit status", async () => {
    const result = spawnSync(
      "pnpm",
      ["video", "validate", "missing-composition", "--json"],
      { cwd: workspaceRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: 1,
      ok: false,
      command: "validate",
      error: { code: "UNKNOWN_COMPOSITION" },
    });
  }, 15_000);
});
