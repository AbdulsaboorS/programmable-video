import { compositionManifests } from "@programmable-video/composition-registry";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { promisify } from "node:util";

import { boundTcpPort } from "../src/static-server";

const execFileAsync = promisify(execFile);
const image = process.env.RENDERER_IMAGE ?? "programmable-video-renderer:local";
const containerName = `programmable-video-renderer-smoke-${randomUUID()}`;
const receivedUploads = new Map<string, Buffer>();

const uploadServer = createServer(async (request, response) => {
  const compositionId = /^\/upload\/([^/]+)$/.exec(request.url ?? "")?.[1];
  if (request.method !== "POST" || compositionId === undefined) {
    response.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  response.writeHead(200).end();
  receivedUploads.set(decodeURIComponent(compositionId), Buffer.concat(chunks));
});

await new Promise<void>((resolve) =>
  uploadServer.listen(0, "0.0.0.0", resolve),
);
const uploadPort = boundTcpPort(uploadServer);

try {
  await execFileAsync("docker", [
    "run",
    "--detach",
    "--rm",
    "--platform",
    "linux/amd64",
    "--publish",
    "127.0.0.1::8080",
    "--name",
    containerName,
    image,
  ]);
  const { stdout } = await execFileAsync("docker", [
    "port",
    containerName,
    "8080/tcp",
  ]);
  const port = Number(stdout.trim().split(":").at(-1));
  if (!Number.isInteger(port))
    throw new Error("Docker did not publish port 8080");
  const origin = `http://127.0.0.1:${port}`;
  await waitForRenderer(origin);

  for (const manifest of compositionManifests) {
    const response = await fetch(`${origin}/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobId: randomUUID(),
        buildId: "development",
        compositionId: manifest.id,
        props: manifest.defaultProps,
        streamUpload: {
          videoId: `mock-${manifest.id}`,
          uploadUrl: `http://host.docker.internal:${uploadPort}/upload/${encodeURIComponent(manifest.id)}`,
        },
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(
        `Renderer returned HTTP ${response.status}: ${JSON.stringify(result)}`,
      );
    }
    const upload = receivedUploads.get(manifest.id);
    if (upload === undefined) {
      throw new Error(`${manifest.id} completed without uploading a video`);
    }
    if (!upload.includes(Buffer.from("ftyp"))) {
      throw new Error(`${manifest.id} upload did not contain an MP4 file`);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} finally {
  await execFileAsync("docker", ["stop", containerName]).catch(() => undefined);
  await new Promise<void>((resolve) => uploadServer.close(() => resolve()));
}

async function waitForRenderer(origin: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/ping`);
      if (response.ok) return;
    } catch {
      // The container is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Renderer did not become ready within 30 seconds");
}
