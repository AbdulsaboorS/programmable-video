import {
  compositionManifests,
  getCompositionManifest,
  type CompositionProps,
  type RegisteredCompositionManifest,
} from "@programmable-video/composition-registry";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

import { captureStill, type CapturedStill } from "./capture-still";
import { renderVideo, type RenderedVideo } from "./render-video";
import type { JsonValue } from "./json-value";

type CommandName = "list" | "validate" | "still" | "render";
type ErrorCode =
  | "INVALID_USAGE"
  | "UNKNOWN_COMPOSITION"
  | "INVALID_PROPS"
  | "INVALID_FRAME"
  | "IO_FAILURE"
  | "RENDER_FAILURE";

export interface CommandIo {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

export interface CommandDependencies {
  readFile: (path: string) => Promise<string>;
  captureStill: (options: {
    compositionId: string;
    props: CompositionProps;
    frame: number;
    outputPath: string;
    executablePath?: string;
  }) => Promise<CapturedStill>;
  renderVideo: (options: {
    compositionId: string;
    props: CompositionProps;
    outputPath: string;
    executablePath?: string;
  }) => Promise<RenderedVideo>;
  cwd: string;
  executablePath?: string;
}

interface ParsedOptions {
  json: boolean;
  propsPath?: string;
  outputPath?: string;
  frame?: string;
}

type CompositionSummary = Pick<
  RegisteredCompositionManifest,
  | "id"
  | "label"
  | "description"
  | "spec"
  | "defaultProps"
  | "fields"
  | "reviewFrames"
>;

interface ListCommandData {
  compositions: CompositionSummary[];
}

interface ValidateCommandData {
  compositionId: string;
  props: CompositionProps;
}

interface ArtifactCommandData {
  compositionId: string;
  artifact: CapturedStill | RenderedVideo;
}

type CommandExecution =
  | { command: "list"; data: ListCommandData }
  | { command: "validate"; data: ValidateCommandData }
  | { command: "still" | "render"; data: ArtifactCommandData };

const commandNameSchema = z.enum(["list", "validate", "still", "render"]);
const commandFailureSchema = z.instanceof(Error);
const nodeIoFailureSchema = z.object({ code: z.string() }).passthrough();

class CommandError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly exitCode: 1 | 2 = 1,
  ) {
    super(message);
  }
}

const usage = `Usage:
  pnpm video list [--json]
  pnpm video validate <composition-id> [--props <path>] [--json]
  pnpm video still <composition-id> --frame <number> [--props <path>] [--output <path>] [--json]
  pnpm video render <composition-id> [--props <path>] [--output <path>] [--json]`;

const defaultIo: CommandIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

const defaultDependencies: CommandDependencies = {
  readFile: (path) => readFile(path, "utf8"),
  captureStill,
  renderVideo,
  cwd: process.cwd(),
};
if (process.env.CHROMIUM_EXECUTABLE_PATH !== undefined) {
  defaultDependencies.executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
}

export async function runVideoCommand(
  args: readonly string[],
  io: CommandIo = defaultIo,
  dependencies: CommandDependencies = defaultDependencies,
): Promise<0 | 1 | 2> {
  const requestedCommand = args[0] ?? "unknown";
  const json = args.includes("--json");

  try {
    const command = parseCommandName(requestedCommand);
    const execution = await executeCommand(
      command,
      args.slice(1),
      dependencies,
    );
    writeSuccess(io, execution, json);
    return 0;
  } catch (error) {
    const failure = commandFailureSchema.safeParse(error);
    const commandError =
      error instanceof CommandError
        ? error
        : new CommandError(
            "RENDER_FAILURE",
            failure.success ? failure.data.message : "Unknown failure",
          );
    io.stderr(`video ${requestedCommand}: ${commandError.message}\n`);
    if (commandError.exitCode === 2 && !json) io.stderr(`${usage}\n`);
    if (json) writeFailure(io, requestedCommand, commandError);
    return commandError.exitCode;
  }
}

async function executeCommand(
  command: CommandName,
  args: readonly string[],
  dependencies: CommandDependencies,
): Promise<CommandExecution> {
  if (command === "list") {
    parseOptions(args, new Set(["json"]), 0);
    return {
      command,
      data: {
        compositions: compositionManifests.map((manifest) => ({
          id: manifest.id,
          label: manifest.label,
          description: manifest.description,
          spec: manifest.spec,
          defaultProps: manifest.defaultProps,
          fields: manifest.fields,
          reviewFrames: manifest.reviewFrames,
        })),
      },
    };
  }

  const compositionId = args[0];
  if (compositionId === undefined || compositionId.startsWith("--")) {
    throw invalidUsage(`${command} requires a composition ID`);
  }
  const allowed =
    command === "validate"
      ? new Set(["props", "json"])
      : command === "still"
        ? new Set(["frame", "props", "output", "json"])
        : new Set(["props", "output", "json"]);
  const options = parseOptions(args.slice(1), allowed, 0);
  const manifest = getCompositionManifest(compositionId);
  if (manifest === undefined) {
    throw new CommandError(
      "UNKNOWN_COMPOSITION",
      `Unknown composition: ${compositionId}`,
    );
  }
  const props = await loadProps(manifest, options.propsPath, dependencies);

  if (command === "validate") {
    return { command, data: { compositionId: manifest.id, props } };
  }

  if (command === "still") {
    const frame = parseFrame(options.frame, manifest.spec.durationInFrames);
    const outputPath = resolve(
      dependencies.cwd,
      options.outputPath ?? `out/${manifest.id}-frame-${frame}.png`,
    );
    const captureOptions: Parameters<CommandDependencies["captureStill"]>[0] = {
      compositionId: manifest.id,
      props,
      frame,
      outputPath,
    };
    if (dependencies.executablePath !== undefined) {
      captureOptions.executablePath = dependencies.executablePath;
    }
    const artifact = await runArtifact(() =>
      dependencies.captureStill(captureOptions),
    );
    return { command, data: { compositionId: manifest.id, artifact } };
  }

  const outputPath = resolve(
    dependencies.cwd,
    options.outputPath ?? `out/${manifest.id}.mp4`,
  );
  const renderOptions: Parameters<CommandDependencies["renderVideo"]>[0] = {
    compositionId: manifest.id,
    props,
    outputPath,
  };
  if (dependencies.executablePath !== undefined) {
    renderOptions.executablePath = dependencies.executablePath;
  }
  const artifact = await runArtifact(() =>
    dependencies.renderVideo(renderOptions),
  );
  return { command, data: { compositionId: manifest.id, artifact } };
}

function parseCommandName(value: string): CommandName {
  const parsed = commandNameSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw invalidUsage(`Unknown command: ${value}`);
}

function parseOptions(
  args: readonly string[],
  allowed: ReadonlySet<string>,
  positionalCount: number,
): ParsedOptions {
  if (positionalCount !== 0) throw new Error("Unsupported positional count");
  const options: ParsedOptions = { json: false };
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined || !argument.startsWith("--")) {
      throw invalidUsage(`Unexpected argument: ${argument ?? ""}`);
    }
    const name = argument.slice(2);
    if (!allowed.has(name)) throw invalidUsage(`Unknown option: ${argument}`);
    if (seen.has(name)) throw invalidUsage(`Duplicate option: ${argument}`);
    seen.add(name);

    if (name === "json") {
      options.json = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw invalidUsage(`${argument} requires a value`);
    }
    index += 1;
    if (name === "props") options.propsPath = value;
    if (name === "output") options.outputPath = value;
    if (name === "frame") options.frame = value;
  }

  return options;
}

async function loadProps(
  manifest: (typeof compositionManifests)[number],
  propsPath: string | undefined,
  dependencies: CommandDependencies,
): Promise<CompositionProps> {
  let value: JsonValue = manifest.defaultProps;
  if (propsPath !== undefined) {
    let source: string;
    try {
      source = await dependencies.readFile(
        resolve(dependencies.cwd, propsPath),
      );
    } catch (error) {
      const failure = commandFailureSchema.safeParse(error);
      throw new CommandError(
        "IO_FAILURE",
        `Could not read props file ${propsPath}: ${failure.success ? failure.data.message : "Unknown failure"}`,
      );
    }
    try {
      value = JSON.parse(source);
    } catch {
      throw new CommandError(
        "INVALID_PROPS",
        `Props file ${propsPath} is not valid JSON`,
      );
    }
  }

  const result = manifest.propsSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const location = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new CommandError(
      "INVALID_PROPS",
      `Invalid props for ${manifest.id}: ${location}${issue?.message ?? "validation failed"}`,
    );
  }
  const props: CompositionProps = result.data;
  return props;
}

function parseFrame(
  value: string | undefined,
  durationInFrames: number,
): number {
  if (value === undefined)
    throw invalidUsage("still requires --frame <number>");
  if (!/^-?\d+$/.test(value)) {
    throw new CommandError("INVALID_FRAME", "Frame must be an integer");
  }
  const frame = Number(value);
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= durationInFrames) {
    throw new CommandError(
      "INVALID_FRAME",
      `Frame must be an integer from 0 to ${durationInFrames - 1}`,
    );
  }
  return frame;
}

async function runArtifact<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const ioFailure = nodeIoFailureSchema.safeParse(error);
    const failure = commandFailureSchema.safeParse(error);
    const message = failure.success ? failure.data.message : "Unknown failure";
    if (ioFailure.success) {
      throw new CommandError("IO_FAILURE", message);
    }
    throw new CommandError("RENDER_FAILURE", message);
  }
}

function invalidUsage(message: string): CommandError {
  return new CommandError("INVALID_USAGE", message, 2);
}

function writeSuccess(
  io: CommandIo,
  execution: CommandExecution,
  json: boolean,
): void {
  if (json) {
    io.stdout(
      `${JSON.stringify({ version: 1, ok: true, command: execution.command, data: execution.data })}\n`,
    );
    return;
  }
  if (execution.command === "list") {
    const compositions = execution.data.compositions;
    io.stdout(
      `${compositions.map(({ id, label }) => `${id}\t${label}`).join("\n")}\n`,
    );
    return;
  }
  if (execution.command === "validate") {
    io.stdout(`Valid props for ${execution.data.compositionId}\n`);
    return;
  }
  io.stdout(`${execution.data.artifact.outputPath}\n`);
}

function writeFailure(
  io: CommandIo,
  command: string,
  error: CommandError,
): void {
  io.stdout(
    `${JSON.stringify({
      version: 1,
      ok: false,
      command,
      error: { code: error.code, message: error.message },
    })}\n`,
  );
}
