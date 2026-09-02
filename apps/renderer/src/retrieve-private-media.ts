import {
  finishingAudioMaxBytes,
  type FinishingSpec,
} from "@programmable-video/contracts";
import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";

export interface PrivateMediaCapability {
  url: string;
  token: string;
  sha256: string;
  byteSize: number;
}

export function assertAudioCapability(
  finishingSpec: FinishingSpec | undefined,
  capability: PrivateMediaCapability | undefined,
): void {
  if (finishingSpec?.audio === null || finishingSpec === undefined) {
    if (capability !== undefined) {
      throw new Error("Audio capability requires finishing audio");
    }
    return;
  }
  if (
    capability === undefined ||
    capability.sha256 !== finishingSpec.audio.asset.sha256
  ) {
    throw new Error("Finishing audio requires its digest-bound capability");
  }
}

export async function retrievePrivateMedia(
  capability: PrivateMediaCapability,
  outputPath: string,
): Promise<void> {
  if (capability.byteSize > finishingAudioMaxBytes) {
    throw new Error("Private media is too large");
  }
  assertPrivateMediaUrl(capability.url);
  const response = await fetch(capability.url, {
    headers: { authorization: `Bearer ${capability.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error("Could not retrieve private media");

  const declaredSize = response.headers.get("content-length");
  if (declaredSize !== null && Number(declaredSize) !== capability.byteSize) {
    throw new Error("Private media size does not match capability");
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Private media response has no body");
  const file = await open(outputPath, "wx", 0o600);
  const hash = createHash("sha256");
  let byteSize = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteSize += value.byteLength;
      if (byteSize > capability.byteSize) {
        await reader.cancel("Private media exceeds declared size");
        throw new Error("Private media size does not match capability");
      }
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await file.write(
          value,
          offset,
          value.byteLength - offset,
        );
        if (bytesWritten === 0)
          throw new Error("Could not write private media");
        offset += bytesWritten;
      }
    }
    if (byteSize !== capability.byteSize) {
      throw new Error("Private media size does not match capability");
    }
    if (hash.digest("hex") !== capability.sha256) {
      throw new Error("Private media digest does not match capability");
    }
    completed = true;
  } finally {
    await file.close();
    if (!completed) await unlink(outputPath).catch(() => undefined);
  }
}

function assertPrivateMediaUrl(value: string): void {
  const url = new URL(value);
  const localDevelopmentOrigin =
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]");
  if (url.protocol !== "https:" && !localDevelopmentOrigin) {
    throw new Error("Private media capability URL must use HTTPS");
  }
}
