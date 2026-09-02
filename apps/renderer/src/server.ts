import { parseContainerRenderRequest } from "@programmable-video/composition-registry";
import {
  finishingSpecSchema,
  managedContainerRenderRequestSchema,
  type FinishingSpec,
} from "@programmable-video/contracts";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import { assertSafeArchiveEntries } from "./archive-entries";
import {
  renderManagedVideo,
  renderVideo,
  type RenderFinishingOptions,
} from "./render-video";
import {
  assertAudioCapability,
  retrievePrivateMedia,
} from "./retrieve-private-media";
import { createStaticHandler, listen } from "./static-server";
import { uploadVideo } from "./upload-video";
import type { JsonValue } from "./json-value";
import { audioValidationRequestSchema, validateAudio } from "./validate-audio";

const maxRequestBytes = 1024 * 1024;
const maxArtifactBytes = 25 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const staticHandler = createStaticHandler();
const rendererFailureSchema = z.instanceof(Error);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://renderer.local");
  if (request.method === "GET" && url.pathname === "/ping") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/render") {
    void handleRender(request, response);
    return;
  }
  if (request.method === "POST" && url.pathname === "/render-managed") {
    void handleManagedRender(request, response);
    return;
  }
  if (request.method === "POST" && url.pathname === "/validate-audio") {
    void handleValidateAudio(request, response);
    return;
  }
  staticHandler(request, response);
});

const port = parsePort(process.env.PORT);
await listen(server, port, "0.0.0.0");
process.stdout.write(`Renderer listening on port ${port}\n`);

async function handleRender(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let temporaryDirectory: string | undefined;
  let stage: "validation" | "render" | "upload" = "validation";
  try {
    const payload = parseContainerRenderRequest(
      JSON.parse(await readBody(request)),
    );
    stage = "render";
    temporaryDirectory = await mkdtemp(join(tmpdir(), "video-render-"));
    const outputPath = join(temporaryDirectory, `${payload.jobId}.mp4`);
    const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
    const renderOptions: Parameters<typeof renderVideo>[0] = {
      compositionId: payload.compositionId,
      props: payload.props,
      outputPath,
    };
    if (executablePath !== undefined)
      renderOptions.executablePath = executablePath;
    const video = await renderVideo(renderOptions);
    if (video.buildId !== payload.buildId) {
      throw new Error(
        `Render build mismatch: requested ${payload.buildId}, loaded ${video.buildId}`,
      );
    }
    stage = "upload";
    await uploadVideo(payload.streamUpload.uploadUrl, outputPath);
    sendJson(response, 200, {
      jobId: payload.jobId,
      buildId: payload.buildId,
      videoId: payload.streamUpload.videoId,
      video: {
        codec: video.codec,
        width: video.width,
        height: video.height,
        fps: video.fps,
        durationInFrames: video.durationInFrames,
      },
    });
  } catch (error) {
    const validationError = stage === "validation";
    const failure = rendererFailureSchema.safeParse(error);
    sendJson(response, validationError ? 400 : 500, {
      error: {
        stage,
        message: validationError
          ? "Invalid render request"
          : failure.success
            ? failure.data.message
            : "Render failed",
      },
    });
  } finally {
    if (temporaryDirectory !== undefined) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}

async function handleManagedRender(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let temporaryDirectory: string | undefined;
  let stage: "validation" | "render" | "upload" = "validation";
  try {
    const payload = managedContainerRenderRequestSchema.parse(
      JSON.parse(await readBody(request)),
    );
    const finishingSpec = finishingSpecSchema.parse(payload.finishingSpec);
    assertAudioCapability(finishingSpec, payload.audioCapability);
    temporaryDirectory = await mkdtemp(join(tmpdir(), "managed-video-render-"));
    const staticRoot = await retrieveManagedArtifact(
      payload,
      temporaryDirectory,
    );
    stage = "render";
    const outputPath = join(temporaryDirectory, `${payload.jobId}.mp4`);
    const audioPath =
      payload.audioCapability === undefined
        ? undefined
        : join(temporaryDirectory, "private-audio-input");
    if (payload.audioCapability !== undefined && audioPath !== undefined) {
      await retrievePrivateMedia(payload.audioCapability, audioPath);
    }
    const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
    const renderOptions: Parameters<typeof renderManagedVideo>[0] = {
      staticRoot,
      commitSha: payload.manifest.commitSha,
      buildAttempt: payload.manifest.attempt,
      inputDigest: payload.manifest.inputDigest,
      outputPath,
      finishing: rendererFinishing(finishingSpec, audioPath),
    };
    if (executablePath !== undefined)
      renderOptions.executablePath = executablePath;
    const video = await renderManagedVideo(renderOptions);
    stage = "upload";
    await uploadVideo(payload.streamUpload.uploadUrl, outputPath);
    sendJson(response, 200, {
      jobId: payload.jobId,
      manifestDigest: payload.manifestDigest,
      videoId: payload.streamUpload.videoId,
      video: {
        codec: video.codec,
        width: video.width,
        height: video.height,
        fps: video.fps,
        durationInFrames: video.durationInFrames,
      },
    });
  } catch (error) {
    const failure = rendererFailureSchema.safeParse(error);
    sendJson(response, stage === "validation" ? 400 : 500, {
      error: {
        stage,
        message:
          stage === "validation"
            ? "Invalid managed render request"
            : failure.success
              ? failure.data.message
              : "Render failed",
      },
    });
  } finally {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}

async function handleValidateAudio(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let payload: ReturnType<typeof audioValidationRequestSchema.parse>;
  try {
    payload = audioValidationRequestSchema.parse(
      JSON.parse(await readBody(request)),
    );
  } catch {
    sendJson(response, 400, {
      valid: false,
      error: "Invalid audio validation request",
    });
    return;
  }

  try {
    sendJson(response, 200, await validateAudio(payload));
  } catch (error) {
    const failure = rendererFailureSchema.safeParse(error);
    process.stderr.write(
      `Audio validation failed: ${failure.success ? failure.data.message : "Render failed"}\n`,
    );
    sendJson(response, 500, { error: "Audio validation failed" });
  }
}

function rendererFinishing(
  spec: FinishingSpec,
  audioPath: string | undefined,
): RenderFinishingOptions {
  const finishing = {
    startFrame: spec.trim.startFrame,
    endFrame: spec.trim.endFrame,
    profile: spec.output.profile,
    fit: spec.output.fit,
  };
  if (spec.audio === null) return finishing;
  if (audioPath === undefined) {
    throw new Error("Finishing audio input is unavailable");
  }
  return {
    ...finishing,
    audio: { path: audioPath, gain: spec.audio.gainPercent / 100 },
  };
}

async function retrieveManagedArtifact(
  payload: ReturnType<typeof managedContainerRenderRequestSchema.parse>,
  temporaryDirectory: string,
): Promise<string> {
  if (
    sha256(Buffer.from(JSON.stringify(payload.manifest))) !==
    payload.manifestDigest
  ) {
    throw new Error("Managed manifest digest does not match");
  }
  const artifactResponse = await fetch(payload.artifactUrl, {
    headers: { authorization: `Bearer ${payload.artifactToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  if (!artifactResponse.ok)
    throw new Error("Could not retrieve approved artifact");
  const declaredSize = Number(artifactResponse.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxArtifactBytes) {
    throw new Error("Approved artifact is too large");
  }
  const archive = Buffer.from(await artifactResponse.arrayBuffer());
  if (archive.byteLength > maxArtifactBytes)
    throw new Error("Approved artifact is too large");
  const archivePath = join(temporaryDirectory, "artifact.tar.gz");
  const staticRoot = join(temporaryDirectory, "artifact");
  await writeFile(archivePath, archive, { mode: 0o600 });
  const { stdout } = await execFileAsync("tar", ["-tzf", archivePath], {
    maxBuffer: 1024 * 1024,
  });
  assertSafeArchiveEntries(stdout);
  await mkdir(staticRoot, { recursive: true });
  await execFileAsync("tar", [
    "-xzf",
    archivePath,
    "-C",
    staticRoot,
    "--no-same-owner",
    "--no-same-permissions",
  ]);
  await verifyFiles(staticRoot, payload.manifest.files);
  return staticRoot;
}

async function verifyFiles(
  root: string,
  expected: Array<{ path: string; size: number; digest: string }>,
): Promise<void> {
  const actual = await regularFiles(root);
  const expectedPaths = expected.map((file) => file.path).sort();
  const actualPaths = actual.map((file) => file.path).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("Approved artifact file set does not match manifest");
  }
  for (const file of expected) {
    const path = resolve(root, file.path);
    if (!path.startsWith(`${resolve(root)}${sep}`))
      throw new Error("Unsafe manifest path");
    const bytes = await readFile(path);
    if (bytes.byteLength !== file.size || sha256(bytes) !== file.digest) {
      throw new Error(
        `Approved artifact file failed verification: ${file.path}`,
      );
    }
  }
}

async function regularFiles(root: string): Promise<Array<{ path: string }>> {
  const result: Array<{ path: string }> = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      if (stats.isSymbolicLink())
        throw new Error("Approved artifact contains a symlink");
      if (stats.isDirectory()) await visit(path);
      else if (stats.isFile())
        result.push({ path: relative(root, path).split(sep).join("/") });
      else throw new Error("Approved artifact contains a non-regular file");
    }
  }
  await visit(root);
  return result;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxRequestBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: JsonValue,
): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 8080;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return parsed;
}
