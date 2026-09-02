import { describe, expect, it, vi } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import {
  finishingAudioMaxBytes,
  finishingAudioMaxDurationMs,
  finishingCaptionMaxBytes,
} from "@programmable-video/contracts";
import { z } from "zod";

import {
  completeProjectAudioValidation,
  createProjectMediaCapability,
  createProjectMediaUpload,
  getProjectMediaByCapability,
  getProjectMediaContent,
  getProjectMediaMetadata,
  listProjectMedia,
  projectMediaCapabilityUrl,
  type ProjectMediaEnv,
  type ProjectMediaKind,
  validateProjectAudioWithRenderer,
  validateWebVtt,
} from "./project-media";
import { multipartOverheadBytes } from "./worker-constants";

const projectId = "0198c7d4-a5e6-7000-8000-000000000000";
const publicationId = "0198c7d4-a5e6-7000-8000-000000000010";
const attemptId = "0198c7d4-a5e6-7000-8000-000000000011";
const owner = "creator@example.com";
const otherOwner = "other@example.com";

interface StoredMedia {
  id: string;
  project_id: string;
  owner_email: string;
  kind: ProjectMediaKind;
  file_name: string;
  media_type: string;
  byte_size: number;
  object_key: string;
  sha256: string;
  validation_status: "pending" | "valid" | "invalid";
  validation_error: string | null;
  decoded_duration_ms: number | null;
  created_at: string;
}

class FakeDatabase {
  projects = new Map([[projectId, owner]]);
  media: StoredMedia[] = [];
  failInsert = false;

  prepare(query: string) {
    const sql = query.replace(/\s+/g, " ").trim();
    return {
      bind: (...values: unknown[]) => ({
        first: async () => this.first(sql, values) ?? null,
        all: async () => ({ results: this.all(sql, values) }),
        run: async () => this.run(sql, values),
      }),
    };
  }

  private all(sql: string, values: unknown[]) {
    if (!sql.includes("FROM project_media_assets")) {
      throw new Error(`Unexpected all query: ${sql}`);
    }
    return this.media
      .filter(
        (candidate) =>
          candidate.project_id === values[0] &&
          candidate.owner_email === values[1] &&
          (values.length === 2 || candidate.kind === values[2]),
      )
      .reverse();
  }

  private first(sql: string, values: unknown[]) {
    if (sql.startsWith("SELECT id FROM projects")) {
      return this.projects.get(z.string().parse(values[0])) === values[1]
        ? { id: values[0] }
        : undefined;
    }
    if (sql.includes("FROM project_media_assets a")) {
      const media = this.media.find(
        (candidate) =>
          candidate.id === values[0] && candidate.project_id === values[1],
      );
      return media &&
        media.owner_email === values[2] &&
        this.projects.get(media.project_id) === values[3]
        ? media
        : undefined;
    }
    if (
      sql.includes("FROM project_media_assets") &&
      sql.includes("object_key = ?")
    ) {
      return this.media.find(
        (candidate) =>
          candidate.id === values[0] &&
          candidate.project_id === values[1] &&
          candidate.object_key === values[2] &&
          candidate.sha256 === values[3] &&
          candidate.byte_size === values[4] &&
          candidate.media_type === values[5] &&
          (candidate.validation_status === "valid" ||
            (candidate.kind === "audio" &&
              candidate.validation_status === "pending")),
      );
    }
    throw new Error(`Unexpected first query: ${sql}`);
  }

  private async run(sql: string, values: unknown[]) {
    if (sql.startsWith("UPDATE project_media_assets")) {
      const media = this.media.find(
        (candidate) =>
          candidate.id === values[4] &&
          candidate.project_id === values[5] &&
          candidate.owner_email === values[6] &&
          candidate.kind === "audio" &&
          candidate.validation_status === "pending",
      );
      if (media) {
        const [status, error, duration] = z
          .tuple([
            z.enum(["valid", "invalid"]),
            z.string().nullable(),
            z.number().nullable(),
            z.string(),
            z.string(),
            z.string(),
            z.string(),
          ])
          .parse(values);
        media.validation_status = status;
        media.validation_error = error;
        media.decoded_duration_ms = duration;
      }
      return { success: true };
    }
    if (!sql.startsWith("INSERT INTO project_media_assets")) {
      throw new Error(`Unexpected run query: ${sql}`);
    }
    if (this.failInsert) throw new Error("D1 insert failed");
    const value = z
      .tuple([
        z.string(),
        z.string(),
        z.string(),
        z.enum(["audio", "captions"]),
        z.string(),
        z.string(),
        z.number(),
        z.string(),
        z.string(),
        z.enum(["pending", "valid", "invalid"]),
        z.string(),
        z.string(),
      ])
      .parse(values);
    this.media.push({
      id: value[0],
      project_id: value[1],
      owner_email: value[2],
      kind: value[3],
      file_name: value[4],
      media_type: value[5],
      byte_size: value[6],
      object_key: value[7],
      sha256: value[8],
      validation_status: value[9],
      validation_error: null,
      decoded_duration_ms: null,
      created_at: value[10],
    });
    return { success: true };
  }
}

class FakeBucket {
  objects = new Map<
    string,
    {
      bytes: Uint8Array;
      httpMetadata: R2HTTPMetadata;
      customMetadata: Record<string, string>;
      checksum: ArrayBuffer;
    }
  >();
  put = vi.fn(
    async (
      key: string,
      value: Uint8Array,
      options: {
        httpMetadata: R2HTTPMetadata;
        customMetadata: Record<string, string>;
        sha256: ArrayBuffer;
      },
    ) => {
      this.objects.set(key, {
        bytes: new Uint8Array(value),
        httpMetadata: options.httpMetadata,
        customMetadata: options.customMetadata,
        checksum: options.sha256,
      });
      return { key, size: value.byteLength };
    },
  );
  get = vi.fn(async (key: string) => {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      body: new Blob([ownedBuffer(object.bytes)]).stream(),
      size: object.bytes.byteLength,
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
      checksums: { sha256: object.checksum },
    };
  });
  delete = vi.fn(async (key: string) => {
    this.objects.delete(key);
  });
}

function environment(database = new FakeDatabase()) {
  const bucket = new FakeBucket();
  return {
    database,
    bucket,
    env: {
      PREVIEW_SIGNING_KEY: "test-media-signing-key",
      PROJECT_MEDIA: fromPartial<R2Bucket>(bucket),
      PROJECTS_DB: fromPartial<D1Database>(database),
    } satisfies ProjectMediaEnv,
  };
}

function uploadRequest(
  kind: ProjectMediaKind,
  bytes: Uint8Array,
  name: string,
  type: string,
): Request {
  const form = new FormData();
  form.set("file", new File([ownedBuffer(bytes)], name, { type }));
  return new Request(
    `https://studio.example/api/projects/${projectId}/media/${kind}`,
    { method: "POST", body: form },
  );
}

function webVtt(body = "00:00.000 --> 00:01.500\nHello world"): Uint8Array {
  return new TextEncoder().encode(`WEBVTT\n\n${body}\n`);
}

function wav(): Uint8Array {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 38, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, 2, true);
  return bytes;
}

function mp3(): Uint8Array {
  const bytes = new Uint8Array(417);
  bytes.set([0xff, 0xfb, 0x90, 0x00]);
  return bytes;
}

function m4a(): Uint8Array {
  return concatenate([
    box(
      "ftyp",
      Uint8Array.from([...ascii("M4A "), 0, 0, 0, 0, ...ascii("isom")]),
    ),
    box("moov", box("mvhd", Uint8Array.of(0, 0, 0, 0))),
    box("mdat", Uint8Array.of(1)),
  ]);
}

function box(type: string, body: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + body.byteLength);
  new DataView(bytes.buffer).setUint32(0, bytes.byteLength);
  writeAscii(bytes, 4, type);
  bytes.set(body, 8);
  return bytes;
}

function ascii(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0));
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  bytes.set(ascii(value), offset);
}

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((size, chunk) => size + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

describe("project finishing media", () => {
  it.each([
    [mp3(), "track.mp3", "audio/mpeg"],
    [wav(), "track.wav", "audio/wav"],
    [m4a(), "track.m4a", "audio/mp4"],
  ])(
    "stores validated audio with immutable metadata",
    async (bytes, name, type) => {
      const { env, database, bucket } = environment();
      const response = await createProjectMediaUpload(
        uploadRequest("audio", bytes, name, type),
        projectId,
        owner,
        "audio",
        env,
      );

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        projectId,
        kind: "audio",
        fileName: name,
        mediaType: type,
        byteSize: bytes.byteLength,
        validationStatus: "pending",
        decodedDurationMs: null,
      });
      expect(database.media[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(bucket.put).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`^projects/${projectId}/media/.+/original\\.audio$`),
        ),
        expect.any(Uint8Array),
        expect.objectContaining({
          sha256: expect.any(ArrayBuffer),
          customMetadata: expect.objectContaining({ projectId, kind: "audio" }),
        }),
      );
    },
  );

  it("stores a structurally valid English WebVTT asset as usable", async () => {
    const { env } = environment();
    const response = await createProjectMediaUpload(
      uploadRequest("captions", webVtt(), "captions.vtt", "text/vtt"),
      projectId,
      owner,
      "captions",
      env,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      kind: "captions",
      validationStatus: "valid",
      language: "en",
      mediaType: "text/vtt",
    });
  });

  it("checks ownership before consuming or storing the request", async () => {
    const { env, bucket } = environment();
    const response = await createProjectMediaUpload(
      uploadRequest("audio", wav(), "track.wav", "audio/wav"),
      projectId,
      otherOwner,
      "audio",
      env,
    );
    expect(response.status).toBe(404);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it.each([
    ["audio", finishingAudioMaxBytes],
    ["captions", finishingCaptionMaxBytes],
  ] as const)(
    "bounds a lengthless %s multipart request before parsing",
    async (kind, maxBytes) => {
      const { env, bucket } = environment();
      const request = new Request("https://studio.example/upload", {
        method: "POST",
        body: new Uint8Array(maxBytes + multipartOverheadBytes + 1),
      });
      expect(request.headers.get("content-length")).toBeNull();
      const response = await createProjectMediaUpload(
        request,
        projectId,
        owner,
        kind,
        env,
      );
      expect(response.status).toBe(413);
      expect(bucket.put).not.toHaveBeenCalled();
    },
  );

  it.each([
    [new Uint8Array(), "track.mp3", "audio/mpeg"],
    [new TextEncoder().encode("ID3 but no frames"), "track.mp3", "audio/mpeg"],
    [concatenate([mp3(), Uint8Array.of(1)]), "track.mp3", "audio/mpeg"],
    [wav().slice(0, -1), "track.wav", "audio/wav"],
    [
      concatenate([m4a(), new TextEncoder().encode("polyglot")]),
      "track.m4a",
      "audio/mp4",
    ],
    [wav(), "track.mp3", "audio/mpeg"],
    [wav(), "track.wav", "application/octet-stream"],
  ])(
    "rejects malformed, polyglot, and mismatched audio",
    async (bytes, name, type) => {
      const { env, bucket } = environment();
      const response = await createProjectMediaUpload(
        uploadRequest("audio", bytes, name, type),
        projectId,
        owner,
        "audio",
        env,
      );
      expect(response.status).toBe(400);
      expect(bucket.put).not.toHaveBeenCalled();
    },
  );

  it.each([
    new TextEncoder().encode("not webvtt"),
    new TextEncoder().encode(
      "WEBVTT\n00:00.000 --> 00:01.000\nNo blank header line",
    ),
    webVtt("00:01.000 --> 00:00.500\nBackwards"),
    webVtt("00:00.000 --> 00:01.000 unknown:value\nBad setting"),
    webVtt("00:00.000 --> 25:00:00.000\nToo long"),
    Uint8Array.from([0x57, 0x45, 0x42, 0x56, 0x54, 0x54, 0x0a, 0x0a, 0xff]),
  ])("rejects malformed WebVTT", (bytes) => {
    expect(validateWebVtt(bytes)).toBe(false);
  });

  it("accepts identifiers, notes, regions, styles, settings, and a UTF-8 BOM", () => {
    const body =
      "\ufeffWEBVTT English\n\n" +
      "NOTE generated by captions service\nmetadata\n\n" +
      "REGION\nid:fred\nwidth:40%\n\n" +
      "STYLE\n::cue { color: lime; }\n\n" +
      "cue-1\n00:00.000 --> 00:01.250 align:center position:50%\nHello\n";
    expect(validateWebVtt(new TextEncoder().encode(body))).toBe(true);
  });

  it("removes R2 data when immutable D1 persistence fails", async () => {
    const database = new FakeDatabase();
    database.failInsert = true;
    const { env, bucket } = environment(database);
    const response = await createProjectMediaUpload(
      uploadRequest("captions", webVtt(), "captions.vtt", "text/vtt"),
      projectId,
      owner,
      "captions",
      env,
    );
    expect(response.status).toBe(502);
    expect(bucket.delete).toHaveBeenCalledOnce();
    expect(bucket.objects.size).toBe(0);
  });

  it("retrieves metadata and content only through the owning project", async () => {
    const { env } = environment();
    const uploaded = await createProjectMediaUpload(
      uploadRequest("captions", webVtt(), "captions.vtt", "text/vtt"),
      projectId,
      owner,
      "captions",
      env,
    );
    const media = z
      .object({ id: z.string(), sha256: z.string() })
      .parse(await uploaded.json());

    const metadata = await getProjectMediaMetadata(
      projectId,
      media.id,
      owner,
      env,
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      id: media.id,
      sha256: media.sha256,
    });
    const content = await getProjectMediaContent(
      projectId,
      media.id,
      owner,
      env,
    );
    expect(content.status).toBe(200);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(webVtt());
    expect(content.headers.get("x-content-sha256")).toBe(media.sha256);
    expect(
      (await getProjectMediaContent(projectId, media.id, otherOwner, env))
        .status,
    ).toBe(404);
  });

  it("lists project media by kind without exposing another owner", async () => {
    const { env } = environment();
    await createProjectMediaUpload(
      uploadRequest("audio", wav(), "track.wav", "audio/wav"),
      projectId,
      owner,
      "audio",
      env,
    );
    await createProjectMediaUpload(
      uploadRequest("captions", webVtt(), "captions.vtt", "text/vtt"),
      projectId,
      owner,
      "captions",
      env,
    );
    const response = await listProjectMedia(projectId, owner, "audio", env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      assets: [{ kind: "audio", fileName: "track.wav" }],
    });
    expect(
      (await listProjectMedia(projectId, otherOwner, undefined, env)).status,
    ).toBe(404);
  });

  it("serves usable media through a short-lived digest-bound renderer capability", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    try {
      const { env, bucket } = environment();
      const uploaded = await createProjectMediaUpload(
        uploadRequest("captions", webVtt(), "captions.vtt", "text/vtt"),
        projectId,
        owner,
        "captions",
        env,
      );
      const media = z.object({ id: z.string() }).parse(await uploaded.json());
      const token = await createProjectMediaCapability(
        projectId,
        media.id,
        publicationId,
        attemptId,
        owner,
        env,
      );
      expect(token).toBeTypeOf("string");
      expect(
        (await getProjectMediaByCapability(media.id, token!, env)).status,
      ).toBe(200);
      expect(
        (await getProjectMediaByCapability(projectId, token!, env)).status,
      ).toBe(404);

      const [payload, signature] = token!.split(".");
      expect(
        (
          await getProjectMediaByCapability(
            media.id,
            `${payload}a.${signature}`,
            env,
          )
        ).status,
      ).toBe(404);

      const object = [...bucket.objects.values()][0]!;
      object.customMetadata.sha256 = "0".repeat(64);
      expect(
        (await getProjectMediaByCapability(media.id, token!, env)).status,
      ).toBe(404);

      vi.advanceTimersByTime(301_000);
      expect(
        (await getProjectMediaByCapability(media.id, token!, env)).status,
      ).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retrieves pending audio for validation and records bounded decoded duration", async () => {
    const { env } = environment();
    const uploaded = await createProjectMediaUpload(
      uploadRequest("audio", wav(), "track.wav", "audio/wav"),
      projectId,
      owner,
      "audio",
      env,
    );
    const media = z.object({ id: z.string() }).parse(await uploaded.json());
    const token = await createProjectMediaCapability(
      projectId,
      media.id,
      publicationId,
      attemptId,
      owner,
      env,
    );
    expect(token).toBeNull();

    expect(
      (
        await completeProjectAudioValidation(
          projectId,
          media.id,
          owner,
          {
            valid: true,
            decodedDurationMs: finishingAudioMaxDurationMs + 1,
          },
          env,
        )
      ).status,
    ).toBe(400);
    const completed = await completeProjectAudioValidation(
      projectId,
      media.id,
      owner,
      { valid: true, decodedDurationMs: 12_345 },
      env,
    );
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      validationStatus: "valid",
      decodedDurationMs: 12_345,
    });
    const renderToken = await createProjectMediaCapability(
      projectId,
      media.id,
      publicationId,
      attemptId,
      owner,
      env,
    );
    expect(renderToken).toBeTypeOf("string");
    expect(
      (await getProjectMediaByCapability(media.id, renderToken!, env)).status,
    ).toBe(200);

    expect(
      await createProjectMediaCapability(
        projectId,
        media.id,
        publicationId,
        attemptId,
        otherOwner,
        env,
      ),
    ).toBeNull();
  });

  it("validates pending audio through a digest-bound renderer capability", async () => {
    const { env } = environment();
    const uploaded = await createProjectMediaUpload(
      uploadRequest("audio", wav(), "track.wav", "audio/wav"),
      projectId,
      owner,
      "audio",
      env,
    );
    const media = z
      .object({ id: z.string(), sha256: z.string() })
      .parse(await uploaded.json());
    const fetch = vi.fn(async (request: Request) => {
      const payload = z
        .object({
          media: z.object({
            url: z.string(),
            token: z.string(),
            sha256: z.string(),
            byteSize: z.number(),
          }),
          maxDurationMs: z.number(),
        })
        .parse(await request.json());
      expect(request.url).toBe("http://renderer/validate-audio");
      expect(payload.media.url).toBe(
        `https://studio.example/api/internal/project-media/${media.id}`,
      );
      expect(payload.media.url).not.toContain(payload.media.token);
      expect(payload.media.sha256).toBe(media.sha256);
      expect(payload.maxDurationMs).toBe(finishingAudioMaxDurationMs);
      expect(
        (await getProjectMediaByCapability(media.id, payload.media.token, env))
          .status,
      ).toBe(200);
      return Response.json({ valid: true, decodedDurationMs: 2_500 });
    });
    const response = await validateProjectAudioWithRenderer(
      projectId,
      media.id,
      owner,
      "https://studio.example",
      fromPartial<Fetcher>({ fetch }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      validationStatus: "valid",
      decodedDurationMs: 2_500,
    });
  });

  it("builds only HTTPS or explicit localhost capability URLs", () => {
    expect(
      projectMediaCapabilityUrl(
        projectId,
        "https://programmable-video-studio.example",
      ),
    ).toBe(
      `https://programmable-video-studio.example/api/internal/project-media/${projectId}`,
    );
    expect(projectMediaCapabilityUrl(projectId, "http://localhost:8787")).toBe(
      `http://localhost:8787/api/internal/project-media/${projectId}`,
    );
    expect(() =>
      projectMediaCapabilityUrl(projectId, "http://studio.example"),
    ).toThrow("must be an HTTPS origin");
  });
});
