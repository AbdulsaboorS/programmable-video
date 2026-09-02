import { getSandbox, type SandboxProcess } from "@cloudflare/sandbox";
import {
  revisionArtifactManifestSchema,
  revisionCheckResultSchema,
  type RevisionArtifactFile,
  type RevisionArtifactManifest,
  type RevisionCheckName,
  type RevisionCheckResult,
  type ManagedVideoSpec,
} from "@programmable-video/contracts";

import type { BoundaryError } from "./worker-utils";

import type { RevisionTarget } from "./revisions";
import {
  completeRevisionBuild,
  isRevisionBuildActive,
  revisionSandboxId,
} from "./revision-build-lifecycle";
import { parseRevisionVideoSpec } from "./revision-video-spec";

const builderVersion = "managed-revision-v1";
const projectDirectory = "/workspace/project";
const outputDirectory = `${projectDirectory}/dist`;
const maxOutputBytes = 20 * 1024 * 1024;
const maxArchiveBytes = 25 * 1024 * 1024;
const maxFiles = 1_000;
const diagnosticBytes = 65_536;
const tokenTtlSeconds = 5 * 60;

const checks: ReadonlyArray<{
  name: RevisionCheckName;
  command: readonly [string, ...string[]];
  timeout: number;
}> = [
  {
    name: "install",
    command: ["pnpm", "install", "--frozen-lockfile"],
    timeout: 300_000,
  },
  { name: "format", command: ["pnpm", "format:check"], timeout: 180_000 },
  { name: "typecheck", command: ["pnpm", "typecheck"], timeout: 180_000 },
  { name: "test", command: ["pnpm", "test"], timeout: 180_000 },
  { name: "build", command: ["pnpm", "build"], timeout: 180_000 },
];

export async function buildRevision(
  target: RevisionTarget,
  attempt: number,
  leaseOwner: string,
  createdAt: string,
  env: Env,
): Promise<void> {
  if (
    !(await isRevisionBuildActive(
      target.id,
      attempt,
      leaseOwner,
      env.PROJECTS_DB,
    ))
  ) {
    return;
  }
  const results: RevisionCheckResult[] = [];
  let sandbox: ReturnType<typeof getSandbox> | undefined;
  let completion:
    | {
        status: "invalid" | "error" | "ready";
        details: {
          previewPrefix?: string;
          manifestDigest?: string;
          inputDigest?: string;
          videoSpec?: ManagedVideoSpec;
          errorMessage?: string;
        };
      }
    | undefined;
  try {
    sandbox = getSandbox(env.SANDBOX, revisionSandboxId(target.id, attempt));
    const inputDigest = await sha256(
      new TextEncoder().encode(`${target.commitSha}:bundled-default-story-v1`),
    );
    await checkoutRevision(sandbox, target, env);

    for (const check of checks) {
      const result = await runCheck(
        sandbox,
        check,
        check.name === "build"
          ? {
              VIDEO_BUILD_ATTEMPT: String(attempt),
              VIDEO_COMMIT_SHA: target.commitSha,
              VIDEO_INPUT_DIGEST: inputDigest,
            }
          : undefined,
      );
      results.push(result);
      if (result.status === "error") {
        completion = {
          status: "error",
          details: {
            errorMessage: `The ${check.name} check could not complete`,
          },
        };
        break;
      }
      if (result.status === "failed") {
        completion = {
          status: "invalid",
          details: { errorMessage: `The ${check.name} check failed` },
        };
        break;
      }
    }

    if (!completion) {
      completion = {
        status: "ready",
        details: await publishOutput(
          sandbox,
          target,
          attempt,
          inputDigest,
          createdAt,
          env.REVISION_PREVIEWS,
        ),
      };
    }
  } catch (error) {
    completion = {
      status: "error",
      details: { errorMessage: safeError(error) },
    };
  } finally {
    await sandbox?.destroy();
  }
  if (completion) {
    await completeRevisionBuild(
      target.id,
      attempt,
      leaseOwner,
      completion.status,
      results,
      completion.details,
      env.PROJECTS_DB,
    );
  }
}

async function checkoutRevision(
  sandbox: ReturnType<typeof getSandbox>,
  target: RevisionTarget,
  env: Env,
): Promise<void> {
  const repository = await env.ARTIFACTS.get(target.repositoryName);
  const token = await repository.createToken("read", tokenTtlSeconds);
  try {
    await sandbox.mkdir(projectDirectory, { recursive: true });
    await sandbox.writeFile(
      "/workspace/git-askpass.sh",
      '#!/bin/sh\ncase "$1" in *Username*) printf x;; *) printf %s "$ARTIFACTS_GIT_TOKEN";; esac\n',
    );
    await expectSuccess(
      await sandbox.exec(["chmod", "700", "/workspace/git-askpass.sh"]),
      30_000,
    );
    const gitEnv = {
      ARTIFACTS_GIT_TOKEN: token.plaintext,
      GIT_ASKPASS: "/workspace/git-askpass.sh",
      GIT_TERMINAL_PROMPT: "0",
    };
    const commands: ReadonlyArray<readonly [string, ...string[]]> = [
      ["git", "init", projectDirectory],
      [
        "git",
        "-C",
        projectDirectory,
        "remote",
        "add",
        "origin",
        target.repositoryRemoteUrl,
      ],
      [
        "git",
        "-C",
        projectDirectory,
        "fetch",
        "--depth",
        "1",
        "origin",
        target.commitSha,
      ],
      ["git", "-C", projectDirectory, "checkout", "--detach", target.commitSha],
    ];
    for (const command of commands) {
      await expectSuccess(
        await sandbox.exec(command, { env: gitEnv, timeout: 120_000 }),
        120_000,
      );
    }
    const head = await collect(
      await sandbox.exec(["git", "-C", projectDirectory, "rev-parse", "HEAD"], {
        timeout: 30_000,
      }),
      30_000,
    );
    if (
      head.exitCode !== 0 ||
      head.stdout.trim().toLowerCase() !== target.commitSha
    ) {
      throw new Error("Exact revision checkout verification failed");
    }
  } finally {
    await repository.revokeToken(token.id).catch(() => undefined);
  }
}

async function runCheck(
  sandbox: ReturnType<typeof getSandbox>,
  check: (typeof checks)[number],
  env?: Record<string, string>,
): Promise<RevisionCheckResult> {
  const started = Date.now();
  try {
    const options: Parameters<typeof sandbox.exec>[1] = {
      cwd: projectDirectory,
      timeout: check.timeout,
    };
    if (env) options.env = env;
    const output = await collect(
      await sandbox.exec(check.command, options),
      check.timeout + 5_000,
    );
    return revisionCheckResultSchema.parse({
      name: check.name,
      status: output.exitCode === 0 && !output.timedOut ? "passed" : "failed",
      exitCode: output.exitCode,
      durationMs: Math.min(Date.now() - started, 15 * 60 * 1_000),
      stdout: tail(output.stdout),
      stderr: tail(output.stderr),
    });
  } catch (error) {
    return revisionCheckResultSchema.parse({
      name: check.name,
      status: "error",
      exitCode: null,
      durationMs: Math.min(Date.now() - started, 15 * 60 * 1_000),
      stdout: "",
      stderr: tail(safeError(error)),
    });
  }
}

async function publishOutput(
  sandbox: ReturnType<typeof getSandbox>,
  target: RevisionTarget,
  attempt: number,
  inputDigest: string,
  createdAt: string,
  bucket: R2Bucket,
): Promise<{
  previewPrefix: string;
  manifestDigest: string;
  inputDigest: string;
  videoSpec: ManagedVideoSpec;
}> {
  const listing = await sandbox.listFiles(outputDirectory, {
    recursive: true,
    includeHidden: true,
  });
  if (!listing.success) throw new Error("Could not enumerate revision output");
  const files = listing.files.filter((file) => file.type !== "directory");
  if (files.length > maxFiles)
    throw new Error("Revision output contains too many files");
  if (files.some((file) => file.type !== "file")) {
    throw new Error("Revision output may contain only regular files");
  }
  const paths = new Set(files.map((file) => normalizePath(file.relativePath)));
  if (
    !paths.has("index.html") ||
    !paths.has("render.html") ||
    !paths.has("video-spec.json")
  ) {
    throw new Error(
      "Revision output is missing index.html, render.html, or video-spec.json",
    );
  }
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > maxOutputBytes)
    throw new Error("Revision output exceeds 20 MB");

  const prefix = `previews/${target.projectId}/${target.commitSha}/attempt-${attempt}`;
  const manifestFiles: RevisionArtifactFile[] = [];
  let videoSpec: ManagedVideoSpec | undefined;
  let publishedBytes = 0;
  for (const file of files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    const path = normalizePath(file.relativePath);
    const read = await sandbox.readFile(`${outputDirectory}/${path}`, {
      encoding: "none",
    });
    const bytes = new Uint8Array(
      await new Response(read.content).arrayBuffer(),
    );
    if (bytes.byteLength !== file.size) {
      throw new Error("Revision output changed during publication");
    }
    publishedBytes += bytes.byteLength;
    if (publishedBytes > maxOutputBytes) {
      throw new Error("Revision output exceeds 20 MB");
    }
    const digest = await sha256(bytes);
    if (path === "video-spec.json") {
      videoSpec = parseRevisionVideoSpec(bytes);
    }
    const mediaType = mediaTypeFor(path);
    await bucket.put(`${prefix}/files/${path}`, bytes, {
      httpMetadata: { contentType: mediaType },
      customMetadata: { digest },
    });
    manifestFiles.push({ path, size: bytes.byteLength, mediaType, digest });
  }

  const manifest: RevisionArtifactManifest =
    revisionArtifactManifestSchema.parse({
      version: 1,
      projectId: target.projectId,
      revisionId: target.id,
      commitSha: target.commitSha,
      attempt,
      builderVersion,
      previewEntry: "index.html",
      renderEntry: "render.html",
      inputDigest,
      files: manifestFiles,
      createdAt,
    });
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestDigest = await sha256(manifestBytes);

  const archivePath = "/workspace/artifact.tar.gz";
  await expectSuccess(
    await sandbox.exec(
      ["tar", "-czf", archivePath, "-C", outputDirectory, "."],
      { timeout: 60_000 },
    ),
    60_000,
  );
  const archive = await sandbox.readFile(archivePath, { encoding: "none" });
  const archiveBytes = new Uint8Array(
    await new Response(archive.content).arrayBuffer(),
  );
  if (archiveBytes.byteLength > maxArchiveBytes) {
    throw new Error("Revision artifact archive exceeds 25 MB");
  }
  await bucket.put(`${prefix}/artifact.tar.gz`, archiveBytes, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: { manifestDigest },
  });
  await bucket.put(`${prefix}/manifest.json`, manifestBytes, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { manifestDigest },
  });
  if (!videoSpec) throw new Error("Revision video specification is invalid");
  return { previewPrefix: prefix, manifestDigest, inputDigest, videoSpec };
}

async function collect(process: SandboxProcess, timeout: number) {
  return process.output({
    encoding: "utf8",
    maxBytes: diagnosticBytes * 2,
    timeout,
  });
}

async function expectSuccess(
  process: SandboxProcess,
  timeout: number,
): Promise<void> {
  const output = await collect(process, timeout);
  if (output.exitCode !== 0 || output.timedOut) {
    throw new Error(tail(output.stderr) || "Sandbox command failed");
  }
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error("Revision output contains an unsafe path");
  }
  return normalized;
}

function mediaTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return (
    {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    }[extension] ?? "application/octet-stream"
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function tail(value: string): string {
  return value.length <= diagnosticBytes
    ? value
    : value.slice(-diagnosticBytes);
}

function safeError(error: BoundaryError): string {
  return error instanceof Error
    ? error.message.slice(0, 1_000)
    : "Revision build failed";
}
