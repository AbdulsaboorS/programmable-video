import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { uploadVideo, uploadVideoSource } from "../src/upload-video";
import { boundTcpPort } from "../src/static-server";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("uploadVideo", () => {
  it("streams the rendered MP4 as a multipart upload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "renderer-upload-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "video.mp4");
    const video = Buffer.from("mock-mp4-data");
    await writeFile(filePath, video);

    const received = new Promise<{
      body: Buffer;
      contentLength: string | undefined;
      contentType: string | undefined;
    }>((resolve) => {
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        response.writeHead(200).end();
        server.close();
        resolve({
          body: Buffer.concat(chunks),
          contentLength: request.headers["content-length"],
          contentType: request.headers["content-type"],
        });
      });
      server.listen(0, "127.0.0.1", async () => {
        await uploadVideo(
          `http://127.0.0.1:${boundTcpPort(server)}/upload`,
          filePath,
        );
      });
    });

    const upload = await received;
    expect(upload.contentType).toMatch(
      /^multipart\/form-data; boundary=video-render-/,
    );
    expect(Number(upload.contentLength)).toBe(upload.body.length);
    expect(upload.body.includes(video)).toBe(true);
    expect(upload.body.toString()).toContain('filename="render.mp4"');
  });

  it("reports an unsuccessful upload status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "renderer-upload-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "video.mp4");
    await writeFile(filePath, "mock-mp4-data");

    const server = createServer((_request, response) => {
      response.writeHead(503).end("try later");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      await expect(
        uploadVideo(
          `http://127.0.0.1:${boundTcpPort(server)}/upload`,
          filePath,
        ),
      ).rejects.toThrow("Stream upload failed with status 503: try later");
    } finally {
      server.close();
    }
  });

  it("rejects a source read failure and tears down the request", async () => {
    const sourceFailure = new Error("rendered file read failed");
    const server = createServer((request) => request.resume());
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );

    try {
      await expect(
        uploadVideoSource(
          `http://127.0.0.1:${boundTcpPort(server)}/upload`,
          100,
          () =>
            new Readable({
              read() {
                this.destroy(sourceFailure);
              },
            }),
        ),
      ).rejects.toThrow("rendered file read failed");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("rejects an aborted upload response", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
      setImmediate(() => response.socket?.destroy());
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );

    try {
      await expect(
        uploadVideoSource(
          `http://127.0.0.1:${boundTcpPort(server)}/upload`,
          4,
          () => Readable.from([Buffer.from("data")]),
        ),
      ).rejects.toThrow("Stream upload response was aborted");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("rejects a socket reset before the upload response", async () => {
    const server = createServer((request) => request.socket.destroy());
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );

    try {
      await expect(
        uploadVideoSource(
          `http://127.0.0.1:${boundTcpPort(server)}/upload`,
          4,
          () => Readable.from([Buffer.from("data")]),
        ),
      ).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
