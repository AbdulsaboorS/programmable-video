// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  finishingContainBackground,
  finishingSpecVersion,
  type ManagedPublication,
} from "@programmable-video/contracts";

import {
  createPublication,
  loadProjectMedia,
  loadPublications,
  retryPublication,
  uploadProjectAudio,
} from "./project-api";
import type { JsonValue } from "./types";

const projectId = "0198c7d4-a5e6-7000-8000-000000000000";
const revisionId = "0198c7d4-a5e6-7000-8000-000000000103";
const publicationId = "0198c7d4-a5e6-7000-8000-000000000401";
const publication: ManagedPublication = {
  id: publicationId,
  projectId,
  revisionId,
  buildAttempt: 1,
  manifestDigest: "a".repeat(64),
  inputDigest: "b".repeat(64),
  finishingSpecDigest: "c".repeat(64),
  finishingSpec: {
    version: finishingSpecVersion,
    trim: { startFrame: 0, endFrame: 360 },
    output: {
      profile: "landscape",
      width: 1280,
      height: 720,
      fit: "contain",
      containBackground: finishingContainBackground,
    },
    audio: null,
    captions: { mode: "none" },
  },
  attempts: [
    {
      id: "0198c7d4-a5e6-7000-8000-000000000402",
      attempt: 1,
      status: "queued",
      error: null,
      streamVideoId: null,
      playback: { status: "pending" },
      captions: { status: "not_requested" },
      download: { status: "not_requested" },
      createdAt: "2026-08-26T12:00:00.000Z",
      updatedAt: "2026-08-26T12:00:00.000Z",
    },
  ],
  createdAt: "2026-08-26T12:00:00.000Z",
};

function response(value: JsonValue, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("finishing project API", () => {
  it("validates publication history and create/retry responses", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        return response(
          url.endsWith("/publications") && init?.method !== "POST"
            ? { publications: [publication] }
            : publication,
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await loadPublications(projectId)).toHaveLength(1);
    await createPublication(projectId, revisionId, {
      idempotencyKey: "intent-1",
      finishingSpec: publication.finishingSpec,
    });
    await retryPublication(projectId, publicationId);

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/projects/${projectId}/revisions/${revisionId}/publications`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/projects/${projectId}/publications/${publicationId}/retry`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects malformed publication and media responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ publications: [{}] })),
    );
    await expect(loadPublications(projectId)).rejects.toThrow(
      "Publication API returned invalid data",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ assets: [{}] })),
    );
    await expect(loadProjectMedia(projectId)).rejects.toThrow(
      "Media API returned invalid data",
    );
  });

  it("uploads audio as multipart and validates returned metadata", async () => {
    const asset = {
      id: "0198c7d4-a5e6-7000-8000-000000000601",
      projectId,
      kind: "audio",
      fileName: "voice.mp3",
      mediaType: "audio/mpeg",
      byteSize: 3,
      sha256: "d".repeat(64),
      validationStatus: "pending",
      validationError: null,
      decodedDurationMs: null,
      createdAt: "2026-08-26T12:00:00.000Z",
    };
    const validatedAsset = {
      ...asset,
      validationStatus: "valid",
      decodedDurationMs: 2_500,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(asset, 201))
      .mockResolvedValueOnce(response(validatedAsset));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      uploadProjectAudio(
        projectId,
        new File([new Uint8Array([1, 2, 3])], "voice.mp3", {
          type: "audio/mpeg",
        }),
      ),
    ).resolves.toEqual(validatedAsset);
    const uploadCall = fetchMock.mock.calls[0]!;
    expect(uploadCall[0]).toBe(`/api/projects/${projectId}/media/audio`);
    expect(uploadCall[1]?.body).toBeInstanceOf(FormData);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/projects/${projectId}/media/${asset.id}/validate-audio`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects malformed audio validation metadata", async () => {
    const pendingAsset = {
      id: "0198c7d4-a5e6-7000-8000-000000000601",
      projectId,
      kind: "audio",
      fileName: "voice.mp3",
      mediaType: "audio/mpeg",
      byteSize: 3,
      sha256: "d".repeat(64),
      validationStatus: "pending",
      validationError: null,
      decodedDurationMs: null,
      createdAt: "2026-08-26T12:00:00.000Z",
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response(pendingAsset, 201))
        .mockResolvedValueOnce(response({ ...pendingAsset, extra: true })),
    );

    await expect(
      uploadProjectAudio(
        projectId,
        new File([new Uint8Array([1, 2, 3])], "voice.mp3", {
          type: "audio/mpeg",
        }),
      ),
    ).rejects.toThrow("Media API returned invalid data");
  });
});
