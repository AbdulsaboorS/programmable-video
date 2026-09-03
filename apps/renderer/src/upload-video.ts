import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import type { Readable } from "node:stream";
import { rootCertificates } from "node:tls";
import { z } from "zod";

const maxUploadBytes = 200 * 1024 * 1024;
const maxErrorResponseBytes = 8 * 1024;
const containerProxyCaPath =
  "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const fileErrorSchema = z.object({ code: z.string() });

export async function uploadVideo(
  uploadUrl: string,
  filePath: string,
): Promise<void> {
  const fileStat = await stat(filePath);
  if (fileStat.size >= maxUploadBytes) {
    throw new Error("Rendered video exceeds Stream's basic upload limit");
  }
  const proxyCa = await readFile(containerProxyCaPath).catch((error) => {
    const parsed = fileErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  const ca: Array<string | Buffer> = [...rootCertificates];
  if (proxyCa) ca.push(proxyCa);
  const extraCa = process.env.CONTAINER_EXTRA_CA_CERT?.trim();
  if (extraCa) ca.push(extraCa);
  await uploadVideoSource(
    uploadUrl,
    fileStat.size,
    () => createReadStream(filePath),
    ca,
  );
}

type UploadRequest = (
  url: URL,
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

export async function uploadVideoSource(
  uploadUrl: string,
  fileSize: number,
  openSource: () => Readable,
  ca?: string | Buffer | Array<string | Buffer>,
): Promise<void> {
  const boundary = `video-render-${randomUUID()}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="render.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const url = new URL(uploadUrl);
  const request: UploadRequest =
    url.protocol === "https:" ? httpsRequest : httpRequest;
  await new Promise<void>((resolve, reject) => {
    let response: IncomingMessage | undefined;
    let source: Readable | undefined;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      source?.destroy();
      uploadRequest.destroy();
      response?.destroy();
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      source?.destroy();
      uploadRequest.destroy();
      response?.destroy();
      resolve();
    };
    const options: RequestOptions = {
      method: "POST",
      headers: {
        "content-length": String(prefix.length + fileSize + suffix.length),
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
    };
    if (ca) options.ca = ca;
    const uploadRequest = request(url, options, (uploadResponse) => {
      response = uploadResponse;
      const errorResponseChunks: Buffer[] = [];
      let errorResponseBytes = 0;
      uploadResponse.once("error", fail);
      uploadResponse.once("aborted", () =>
        fail(new Error("Stream upload response was aborted")),
      );
      uploadResponse.once("close", () => {
        if (!settled) {
          fail(new Error("Stream upload response closed before completion"));
        }
      });
      uploadResponse.once("end", () => {
        const status = uploadResponse.statusCode ?? 0;
        if (status >= 200 && status < 300) succeed();
        else {
          const detail = Buffer.concat(errorResponseChunks).toString().trim();
          fail(
            new Error(
              `Stream upload failed with status ${status}${detail ? `: ${detail}` : ""}`,
            ),
          );
        }
      });
      uploadResponse.on("data", (chunk: Buffer | string) => {
        if (errorResponseBytes >= maxErrorResponseBytes) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = maxErrorResponseBytes - errorResponseBytes;
        errorResponseChunks.push(buffer.subarray(0, remaining));
        errorResponseBytes += Math.min(buffer.length, remaining);
      });
    });
    uploadRequest.once("error", fail);
    uploadRequest.once("close", () => {
      if (!settled) {
        fail(new Error("Stream upload request closed before completion"));
      }
    });
    uploadRequest.write(prefix, (error) => {
      if (error != null) {
        fail(error);
        return;
      }
      if (settled) return;
      try {
        source = openSource();
      } catch (sourceError) {
        fail(
          sourceError instanceof Error
            ? sourceError
            : new Error("Could not open rendered video"),
        );
        return;
      }
      source.once("error", fail);
      source.once("close", () => {
        if (!settled && source?.readableEnded !== true) {
          fail(new Error("Rendered video source closed before completion"));
        }
      });
      source.once("end", () => {
        if (!settled) uploadRequest.end(suffix);
      });
      source.pipe(uploadRequest, { end: false });
    });
  });
}
