import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { Readable } from "node:stream";

const maxUploadBytes = 200 * 1024 * 1024;

export async function uploadVideo(
  uploadUrl: string,
  filePath: string,
): Promise<void> {
  const fileStat = await stat(filePath);
  if (fileStat.size >= maxUploadBytes) {
    throw new Error("Rendered video exceeds Stream's basic upload limit");
  }
  await uploadVideoSource(uploadUrl, fileStat.size, () =>
    createReadStream(filePath),
  );
}

type UploadRequest = (
  url: URL,
  options: Parameters<typeof httpRequest>[1],
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

export async function uploadVideoSource(
  uploadUrl: string,
  fileSize: number,
  openSource: () => Readable,
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
    const uploadRequest = request(
      url,
      {
        method: "POST",
        headers: {
          "content-length": String(prefix.length + fileSize + suffix.length),
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
      },
      (uploadResponse) => {
        response = uploadResponse;
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
          else fail(new Error(`Stream upload failed with status ${status}`));
        });
        uploadResponse.resume();
      },
    );
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
