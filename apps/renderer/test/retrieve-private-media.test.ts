import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNoOpFinishingSpec } from "@programmable-video/contracts";

import {
  assertAudioCapability,
  retrievePrivateMedia,
} from "../src/retrieve-private-media";

const bytes = Buffer.from("private audio");
const capability = {
  url: "https://media.example.test/assets/request-id",
  token: "t".repeat(32),
  sha256: createHash("sha256").update(bytes).digest("hex"),
  byteSize: bytes.byteLength,
};
let directory: string;

beforeEach(async () => {
  vi.restoreAllMocks();
  directory = await mkdtemp(join(tmpdir(), "private-media-test-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("private media retrieval", () => {
  it("uses only the bearer token and streams verified bytes to a private file", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(bytes, {
        headers: { "content-length": String(bytes.byteLength) },
      }),
    );
    const outputPath = join(directory, "audio-input");

    await retrievePrivateMedia(capability, outputPath);

    expect(fetch).toHaveBeenCalledWith(
      capability.url,
      expect.objectContaining({
        headers: { authorization: `Bearer ${capability.token}` },
        redirect: "error",
      }),
    );
    expect(await readFile(outputPath)).toEqual(bytes);
  });

  it("rejects digest and declared size mismatches without retaining a file", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes));
    const outputPath = join(directory, "audio-input");

    await expect(
      retrievePrivateMedia(
        { ...capability, sha256: "0".repeat(64) },
        outputPath,
      ),
    ).rejects.toThrow("digest does not match");
    await expect(access(outputPath)).rejects.toThrow();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(bytes, { headers: { "content-length": "1" } }),
    );
    await expect(retrievePrivateMedia(capability, outputPath)).rejects.toThrow(
      "size does not match",
    );
  });

  it("aborts a streamed response as soon as it exceeds the capability size", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, capability.byteSize));
        controller.enqueue(new Uint8Array([0]));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    const outputPath = join(directory, "audio-input");

    await expect(retrievePrivateMedia(capability, outputPath)).rejects.toThrow(
      "size does not match",
    );
    expect(cancelled).toBe(true);
    await expect(access(outputPath)).rejects.toThrow();
  });

  it("rejects non-HTTPS URLs except explicit localhost development origins", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(bytes, {
        headers: { "content-length": String(bytes.byteLength) },
      }),
    );
    await expect(
      retrievePrivateMedia(
        { ...capability, url: "http://media.example.test/request-id" },
        join(directory, "rejected"),
      ),
    ).rejects.toThrow("must use HTTPS");
    expect(fetch).not.toHaveBeenCalled();

    await retrievePrivateMedia(
      { ...capability, url: "http://localhost:8787/request-id" },
      join(directory, "local"),
    );
  });
});

describe("private audio capability binding", () => {
  it("requires the capability digest to match the finishing asset", () => {
    const spec = {
      ...createNoOpFinishingSpec(360),
      audio: {
        asset: {
          id: "0198c7d4-a5e6-7000-8000-000000000001",
          sha256: capability.sha256,
        },
        gainPercent: 50,
      },
    };

    expect(() => assertAudioCapability(spec, capability)).not.toThrow();
    expect(() =>
      assertAudioCapability(spec, {
        ...capability,
        sha256: "0".repeat(64),
      }),
    ).toThrow("digest-bound capability");
    expect(() => assertAudioCapability(spec, undefined)).toThrow(
      "digest-bound capability",
    );
  });

  it("rejects capabilities when finishing has no audio", () => {
    expect(() =>
      assertAudioCapability(createNoOpFinishingSpec(360), capability),
    ).toThrow("requires finishing audio");
  });
});
