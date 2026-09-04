import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const maxBundleBytes = 25 * 1024 * 1024;
const configDirectoryName = "programmable-video";
const configFileName = "project.json";
const defaultStudioOrigin = "http://localhost:5173";
const starterDirectory = resolve(
  import.meta.dirname,
  "../../../starters/product-project",
);
const commitPattern = /^[0-9a-f]{40}$/;

const projectIdSchema = z.uuid().transform((value) => value.toLowerCase());
const projectConfigSchema = z
  .object({
    version: z.literal(1),
    projectId: projectIdSchema,
    studioOrigin: z.string(),
  })
  .strict();
const commandErrorSchema = z.instanceof(Error);
const nodeErrorSchema = z.object({ code: z.string() }).passthrough();
const gitFailureSchema = z.object({ stderr: z.string() }).passthrough();

type ProjectConfig = z.infer<typeof projectConfigSchema>;

interface InitOptions {
  directory: string;
  projectId: string;
  studioOrigin: string;
}

interface CommandIo {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

class ProjectCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 = 1,
  ) {
    super(message);
  }
}

const usage = `Usage:
  pnpm project init <directory> --project <uuid> [--studio-origin <origin>]
  pnpm project submit <directory>`;

const defaultIo: CommandIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

export async function runProjectCommand(
  args: readonly string[],
  io: CommandIo = defaultIo,
): Promise<0 | 1 | 2> {
  const command = args[0] ?? "unknown";

  try {
    if (command === "init") {
      const options = parseInitArguments(args.slice(1));
      const result = await initializeProject(options);
      io.stdout(
        `Initialized project ${result.projectId} at ${result.directory}\n`,
      );
      return 0;
    }
    if (command === "submit") {
      const directory = parseSubmitArguments(args.slice(1));
      const result = await submitProject(directory);
      io.stdout(`Submitted ${result.commitSha} from ${result.ref}\n`);
      return 0;
    }
    throw invalidUsage(`Unknown command: ${command}`);
  } catch (error) {
    const parsedError = commandErrorSchema.safeParse(error);
    const failure =
      error instanceof ProjectCommandError
        ? error
        : new ProjectCommandError(
            parsedError.success ? parsedError.data.message : "Unknown failure",
          );
    io.stderr(`project ${command}: ${failure.message}\n`);
    if (failure.exitCode === 2) io.stderr(`${usage}\n`);
    return failure.exitCode;
  }
}

function parseInitArguments(args: readonly string[]): InitOptions {
  const directory = args[0];
  if (directory === undefined || directory.startsWith("--")) {
    throw invalidUsage("init requires a destination directory");
  }

  let projectId: string | undefined;
  let studioOrigin = defaultStudioOrigin;
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option !== "--project" && option !== "--studio-origin") {
      throw invalidUsage(`Unknown argument: ${option ?? ""}`);
    }
    if (seen.has(option)) throw invalidUsage(`Duplicate option: ${option}`);
    seen.add(option);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw invalidUsage(`${option} requires a value`);
    }
    index += 1;
    if (option === "--project") projectId = value;
    else studioOrigin = value;
  }

  if (projectId === undefined)
    throw invalidUsage("init requires --project <uuid>");
  const parsedProjectId = projectIdSchema.safeParse(projectId);
  if (!parsedProjectId.success) throw invalidUsage("--project must be a UUID");

  return {
    directory: resolve(directory),
    projectId: parsedProjectId.data,
    studioOrigin: parseStudioOrigin(studioOrigin, true),
  };
}

function parseSubmitArguments(args: readonly string[]): string {
  if (args.length !== 1 || args[0] === undefined || args[0].startsWith("--")) {
    throw invalidUsage("submit requires exactly one project directory");
  }
  return resolve(args[0]);
}

async function initializeProject(
  options: InitOptions,
): Promise<{ directory: string; projectId: string }> {
  if (
    options.directory === starterDirectory ||
    options.directory.startsWith(`${starterDirectory}${sep}`)
  ) {
    throw new ProjectCommandError(
      "Destination cannot be the starter directory or one of its descendants",
    );
  }
  await requireOutsideGitWorktree(options.directory);
  await requireAbsentOrEmptyDirectory(options.directory);
  await mkdir(options.directory, { recursive: true });
  await cp(starterDirectory, options.directory, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(starterDirectory.length + 1);
      return !relative
        .split(sep)
        .some(
          (part) =>
            part === "node_modules" || part === "dist" || part === ".git",
        );
    },
  });

  await git(options.directory, ["init", "-b", "main"]);
  const gitDirectory = await absoluteGitDirectory(options.directory);
  const configDirectory = join(gitDirectory, configDirectoryName);
  await mkdir(configDirectory, { recursive: true });
  const config: ProjectConfig = {
    version: 1,
    projectId: options.projectId,
    studioOrigin: options.studioOrigin,
  };
  await writeFile(
    join(configDirectory, configFileName),
    `${JSON.stringify(config, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  await git(options.directory, ["add", "--all"]);
  await git(options.directory, [
    "-c",
    "user.name=Programmable Video",
    "-c",
    "user.email=project-cli@programmable.video",
    "commit",
    "-m",
    "Initialize video project",
  ]);

  return { directory: options.directory, projectId: options.projectId };
}

async function requireOutsideGitWorktree(directory: string): Promise<void> {
  let existingParent = dirname(directory);
  while (true) {
    try {
      await stat(existingParent);
      break;
    } catch (error) {
      const parsedError = nodeErrorSchema.safeParse(error);
      if (!parsedError.success || parsedError.data.code !== "ENOENT")
        throw error;
      const parent = dirname(existingParent);
      if (parent === existingParent) return;
      existingParent = parent;
    }
  }

  try {
    await execFileAsync(
      "git",
      ["-C", existingParent, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    );
  } catch {
    return;
  }
  throw new ProjectCommandError(
    "Destination must be outside every existing Git worktree",
  );
}

async function submitProject(
  directory: string,
): Promise<{ commitSha: string; ref: string }> {
  const gitDirectory = await absoluteGitDirectory(directory);
  const config = await readProjectConfig(gitDirectory);
  const status = await git(directory, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status !== "") {
    throw new ProjectCommandError(
      "Worktree is not clean. Commit or remove all changes before submitting.",
    );
  }

  let ref: string;
  try {
    ref = await git(directory, ["symbolic-ref", "--quiet", "HEAD"]);
  } catch {
    throw new ProjectCommandError("HEAD must point to a local branch");
  }
  if (!ref.startsWith("refs/heads/")) {
    throw new ProjectCommandError("HEAD must point to a local branch");
  }
  if (ref !== "refs/heads/main") {
    throw new ProjectCommandError("HEAD must point to the main branch");
  }
  const commitSha = await git(directory, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]);
  if (!commitPattern.test(commitSha)) {
    throw new ProjectCommandError(
      "HEAD must resolve to a full lowercase 40-character commit SHA",
    );
  }

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "video-project-bundle-"),
  );
  const bundlePath = join(temporaryDirectory, "revision.bundle");
  try {
    await git(directory, ["bundle", "create", bundlePath, "HEAD", ref]);
    const bundle = await readBundle(bundlePath);
    if (bundle.byteLength > maxBundleBytes) {
      throw new ProjectCommandError(
        `Git bundle exceeds the 25 MiB limit (${bundle.byteLength} bytes)`,
      );
    }
    const bundleSha256 = createHash("sha256").update(bundle).digest("hex");
    const endpoint = new URL(
      `/api/projects/${encodeURIComponent(config.projectId)}/revisions`,
      config.studioOrigin,
    );
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-length": String(bundle.byteLength),
          "content-type": "application/x-git-bundle",
          "x-video-bundle-sha256": bundleSha256,
          "x-video-commit-sha": commitSha,
          "x-video-ref": ref,
        },
        body: new Uint8Array(bundle),
      });
    } catch (error) {
      const parsedError = commandErrorSchema.safeParse(error);
      throw new ProjectCommandError(
        `Could not reach Studio at ${config.studioOrigin}: ${parsedError.success ? parsedError.data.message : "Unknown failure"}`,
      );
    }
    if (!response.ok) {
      const detail = (await response.text()).trim().slice(0, 500);
      throw new ProjectCommandError(
        `Studio rejected the revision (${response.status}${detail === "" ? "" : `: ${detail}`})`,
      );
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  return { commitSha, ref };
}

async function requireAbsentOrEmptyDirectory(directory: string): Promise<void> {
  try {
    const entries = await readdir(directory);
    if (entries.length !== 0) {
      throw new ProjectCommandError(
        `Destination must be absent or empty: ${directory}`,
      );
    }
  } catch (error) {
    const parsedError = nodeErrorSchema.safeParse(error);
    if (parsedError.success && parsedError.data.code === "ENOENT") return;
    throw error;
  }
}

async function absoluteGitDirectory(directory: string): Promise<string> {
  try {
    return await git(directory, ["rev-parse", "--absolute-git-dir"]);
  } catch (error) {
    const parsedError = commandErrorSchema.safeParse(error);
    throw new ProjectCommandError(
      `Not a Git project: ${directory} (${parsedError.success ? parsedError.data.message : "Unknown failure"})`,
    );
  }
}

async function readProjectConfig(gitDirectory: string): Promise<ProjectConfig> {
  const path = join(gitDirectory, configDirectoryName, configFileName);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const parsedError = commandErrorSchema.safeParse(error);
    throw new ProjectCommandError(
      `Project configuration is missing or invalid at ${path}: ${parsedError.success ? parsedError.data.message : "Unknown failure"}`,
    );
  }
  const parsed = projectConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProjectCommandError(
      `Invalid project configuration at ${path}: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
    );
  }
  return {
    version: 1,
    projectId: parsed.data.projectId,
    studioOrigin: parseStudioOrigin(parsed.data.studioOrigin, false),
  };
}

function parseStudioOrigin(value: string, usageError: boolean): string {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("not an HTTP(S) origin");
    }
    return url.origin;
  } catch {
    throw new ProjectCommandError(
      "Studio origin must be a loopback HTTP(S) origin without a path",
      usageError ? 2 : 1,
    );
  }
}

async function readBundle(path: string): Promise<Buffer> {
  const metadata = await stat(path);
  if (metadata.size > maxBundleBytes) {
    throw new ProjectCommandError(
      `Git bundle exceeds the 25 MiB limit (${metadata.size} bytes)`,
    );
  }
  const handle = await open(path, "r");
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function git(
  directory: string,
  args: readonly string[],
): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return result.stdout.trim();
  } catch (error) {
    const gitFailure = gitFailureSchema.safeParse(error);
    const commandError = commandErrorSchema.safeParse(error);
    const detail = gitFailure.success
      ? gitFailure.data.stderr.trim()
      : commandError.success
        ? commandError.data.message
        : "Unknown failure";
    throw new ProjectCommandError(
      `Git command failed (git ${args.join(" ")}): ${detail || "unknown error"}`,
    );
  }
}

function invalidUsage(message: string): ProjectCommandError {
  return new ProjectCommandError(message, 2);
}

export const projectConfigPath = join(configDirectoryName, configFileName);
export const projectStarterDirectory = starterDirectory;
