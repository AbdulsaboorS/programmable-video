import {
  finishingAudioMaxBytes,
  finishingAudioMaxDurationMs,
  finishingCaptionMaxBytes,
  projectMediaAssetSchema,
  type ProjectMediaAsset,
} from "@programmable-video/contracts";
import { z } from "zod";

import { multipartOverheadBytes } from "./worker-constants";
import { base64Url, isUuid, platformFailure } from "./worker-utils";

const capabilityTtlSeconds = 5 * 60;
const maxWebVttBlocks = 10_000;
const maxWebVttLines = 50_000;
const maxWebVttTimestampMs = 24 * 60 * 60 * 1000;

export type ProjectMediaKind = "audio" | "captions";

export interface ProjectMediaEnv {
  PREVIEW_SIGNING_KEY: string;
  PROJECT_MEDIA: R2Bucket;
  PROJECTS_DB: D1Database;
}

export type ProjectMediaMetadata = ProjectMediaAsset;
export type ProjectAudioValidationResult =
  { valid: true; decodedDurationMs: number } | { valid: false; error: string };

interface MediaRow {
  id: string;
  project_id: string;
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

const mediaCapabilitySchema = z.object({
  version: z.literal(1),
  purpose: z.enum(["project-media-render", "project-media-validation"]),
  publicationId: z.string().refine(isUuid),
  attemptId: z.string().refine(isUuid),
  projectId: z.string().refine(isUuid),
  assetId: z.string().refine(isUuid),
  objectKey: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteSize: z.number().int().positive().max(finishingAudioMaxBytes),
  mediaType: z.string().max(127),
  expiresAt: z.number().int(),
});

type MediaCapability = z.infer<typeof mediaCapabilitySchema>;

const audioValidationResultSchema = z.discriminatedUnion("valid", [
  z.object({ valid: z.literal(true), decodedDurationMs: z.number() }),
  z.object({ valid: z.literal(false), error: z.string() }),
]);

interface UploadDefinition {
  maxBytes: number;
  tooLargeMessage: string;
  invalidMessage: string;
  validate(file: File, bytes: Uint8Array): boolean;
  validationStatus: MediaRow["validation_status"];
  extension: string;
}

const uploadDefinitions = {
  audio: {
    maxBytes: finishingAudioMaxBytes,
    tooLargeMessage: "Audio exceeds 25 MiB",
    invalidMessage: "Audio must be a valid MP3, WAV, or M4A file",
    validate: validateAudio,
    validationStatus: "pending",
    extension: "audio",
  },
  captions: {
    maxBytes: finishingCaptionMaxBytes,
    tooLargeMessage: "Captions exceed 1 MiB",
    invalidMessage: "Captions must be valid English WebVTT",
    validate: validateCaptions,
    validationStatus: "valid",
    extension: "vtt",
  },
} satisfies Record<ProjectMediaKind, UploadDefinition>;

export async function createProjectMediaUpload(
  request: Request,
  projectId: string,
  ownerEmail: string,
  kind: ProjectMediaKind,
  env: ProjectMediaEnv,
): Promise<Response> {
  const definition = uploadDefinitions[kind];
  if (!definition || !isUuid(projectId)) return notFound();

  try {
    if (!(await ownsProject(projectId, ownerEmail, env.PROJECTS_DB))) {
      return notFound();
    }
  } catch (error) {
    return platformFailure("Could not load the product project", error);
  }

  const requestLimit = definition.maxBytes + multipartOverheadBytes;
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > requestLimit) {
    return tooLarge(definition.tooLargeMessage);
  }

  let form: FormData;
  try {
    const body = await readLimitedBytes(request, requestLimit);
    form = await new Request(request.url, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      body,
    }).formData();
  } catch (error) {
    return error instanceof MediaTooLargeError
      ? tooLarge(definition.tooLargeMessage)
      : invalidUpload(kind);
  }

  if (
    [...form.keys()].some((key) => key !== "file") ||
    form.getAll("file").length !== 1
  ) {
    return invalidUpload(kind);
  }
  const file = form.get("file");
  if (!(file instanceof File) || !validFileName(file.name)) {
    return invalidUpload(kind);
  }
  if (file.size > definition.maxBytes) {
    return tooLarge(definition.tooLargeMessage);
  }
  if (file.size === 0) {
    return Response.json({ error: definition.invalidMessage }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!definition.validate(file, bytes)) {
    return Response.json({ error: definition.invalidMessage }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const digest = await sha256(bytes);
  const sha256Hex = hex(digest);
  const objectKey = `projects/${projectId}/media/${id}/original.${definition.extension}`;
  const createdAt = new Date().toISOString();

  try {
    const stored = await env.PROJECT_MEDIA.put(objectKey, bytes, {
      httpMetadata: {
        contentType: file.type,
        cacheControl: "private, no-store",
      },
      customMetadata: {
        projectId,
        assetId: id,
        kind,
        sha256: sha256Hex,
      },
      sha256: ownedBuffer(digest),
    });
    if (!stored) throw new Error("R2 did not store the media asset");
  } catch (error) {
    return platformFailure("Could not store the media asset", error);
  }

  try {
    await env.PROJECTS_DB.prepare(
      `INSERT INTO project_media_assets (
        id, project_id, owner_email, kind, file_name, media_type, byte_size,
        object_key, sha256, validation_status, validation_error,
        decoded_duration_ms, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
      .bind(
        id,
        projectId,
        ownerEmail,
        kind,
        file.name,
        file.type,
        file.size,
        objectKey,
        sha256Hex,
        definition.validationStatus,
        createdAt,
        createdAt,
      )
      .run();
  } catch (error) {
    await cleanupObject(objectKey, env.PROJECT_MEDIA);
    return platformFailure("Could not save the media asset", error);
  }

  return Response.json(
    metadataFromRow({
      id,
      project_id: projectId,
      kind,
      file_name: file.name,
      media_type: file.type,
      byte_size: file.size,
      object_key: objectKey,
      sha256: sha256Hex,
      validation_status: definition.validationStatus,
      validation_error: null,
      decoded_duration_ms: null,
      created_at: createdAt,
    }),
    { status: 201 },
  );
}

export async function getProjectMediaMetadata(
  projectId: string,
  assetId: string,
  ownerEmail: string,
  env: ProjectMediaEnv,
): Promise<Response> {
  let row: MediaRow | null;
  try {
    row = await findOwnedMedia(projectId, assetId, ownerEmail, env.PROJECTS_DB);
  } catch (error) {
    return platformFailure("Could not load the media asset", error);
  }
  return row ? Response.json(metadataFromRow(row)) : notFound();
}

export async function listProjectMedia(
  projectId: string,
  ownerEmail: string,
  kind: ProjectMediaKind | undefined,
  env: ProjectMediaEnv,
): Promise<Response> {
  if (!isUuid(projectId)) return notFound();
  try {
    if (!(await ownsProject(projectId, ownerEmail, env.PROJECTS_DB))) {
      return notFound();
    }
    const statement = kind
      ? env.PROJECTS_DB.prepare(
          `SELECT id, project_id, kind, file_name, media_type, byte_size,
            object_key, sha256, validation_status, validation_error,
            decoded_duration_ms, created_at
           FROM project_media_assets
           WHERE project_id = ? AND owner_email = ? AND kind = ?
           ORDER BY created_at DESC, id DESC`,
        ).bind(projectId, ownerEmail, kind)
      : env.PROJECTS_DB.prepare(
          `SELECT id, project_id, kind, file_name, media_type, byte_size,
            object_key, sha256, validation_status, validation_error,
            decoded_duration_ms, created_at
           FROM project_media_assets
           WHERE project_id = ? AND owner_email = ?
           ORDER BY created_at DESC, id DESC`,
        ).bind(projectId, ownerEmail);
    const rows = await statement.all<MediaRow>();
    return Response.json({ assets: rows.results.map(metadataFromRow) });
  } catch (error) {
    return platformFailure("Could not load project media", error);
  }
}

export async function getProjectMediaContent(
  projectId: string,
  assetId: string,
  ownerEmail: string,
  env: ProjectMediaEnv,
): Promise<Response> {
  let row: MediaRow | null;
  try {
    row = await findOwnedMedia(projectId, assetId, ownerEmail, env.PROJECTS_DB);
  } catch (error) {
    return platformFailure("Could not load the media asset", error);
  }
  if (!row) return notFound();
  return storedMediaResponse(row, env.PROJECT_MEDIA);
}

export async function completeProjectAudioValidation(
  projectId: string,
  assetId: string,
  ownerEmail: string,
  result: ProjectAudioValidationResult,
  env: ProjectMediaEnv,
): Promise<Response> {
  if (
    (result.valid &&
      (!Number.isInteger(result.decodedDurationMs) ||
        result.decodedDurationMs < 1 ||
        result.decodedDurationMs > finishingAudioMaxDurationMs)) ||
    (!result.valid && (result.error.length < 1 || result.error.length > 1_000))
  ) {
    return Response.json(
      { error: "Invalid audio validation result" },
      { status: 400 },
    );
  }

  let row: MediaRow | null;
  try {
    row = await findOwnedMedia(projectId, assetId, ownerEmail, env.PROJECTS_DB);
    if (!row || row.kind !== "audio") return notFound();
    if (row.validation_status !== "pending") {
      return Response.json(metadataFromRow(row));
    }
    await env.PROJECTS_DB.prepare(
      `UPDATE project_media_assets
       SET validation_status = ?, validation_error = ?, decoded_duration_ms = ?,
         updated_at = ?
       WHERE id = ? AND project_id = ? AND owner_email = ?
         AND kind = 'audio' AND validation_status = 'pending'`,
    )
      .bind(
        result.valid ? "valid" : "invalid",
        result.valid ? null : result.error,
        result.valid ? result.decodedDurationMs : null,
        new Date().toISOString(),
        assetId,
        projectId,
        ownerEmail,
      )
      .run();
    row = await findOwnedMedia(projectId, assetId, ownerEmail, env.PROJECTS_DB);
  } catch (error) {
    return platformFailure("Could not record audio validation", error);
  }
  return row ? Response.json(metadataFromRow(row)) : notFound();
}

export async function validateProjectAudioWithRenderer(
  projectId: string,
  assetId: string,
  ownerEmail: string,
  origin: string,
  renderer: Fetcher,
  env: ProjectMediaEnv,
): Promise<Response> {
  const row = await findOwnedMedia(
    projectId,
    assetId,
    ownerEmail,
    env.PROJECTS_DB,
  );
  if (!row || row.kind !== "audio") return notFound();
  if (row.validation_status !== "pending") {
    return Response.json(metadataFromRow(row));
  }
  const token = await createValidationCapability(
    row,
    crypto.randomUUID(),
    crypto.randomUUID(),
    env.PREVIEW_SIGNING_KEY,
  );
  let mediaUrl: string;
  try {
    mediaUrl = projectMediaCapabilityUrl(assetId, origin);
  } catch (error) {
    return platformFailure("Could not validate the audio asset", error);
  }
  let response: Response;
  try {
    response = await renderer.fetch(
      new Request("http://renderer/validate-audio", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          media: {
            url: mediaUrl,
            token,
            sha256: row.sha256,
            byteSize: row.byte_size,
          },
          maxDurationMs: finishingAudioMaxDurationMs,
        }),
      }),
    );
  } catch (error) {
    return platformFailure("Could not validate the audio asset", error);
  }
  const result = audioValidationResultSchema.safeParse(
    await response.json().catch(() => undefined),
  );
  if (!response.ok || !result.success) {
    return platformFailure(
      "Could not validate the audio asset",
      new Error(`Renderer returned HTTP ${response.status}`),
    );
  }
  return completeProjectAudioValidation(
    projectId,
    assetId,
    ownerEmail,
    result.data,
    env,
  );
}

export async function createProjectMediaCapability(
  projectId: string,
  assetId: string,
  publicationId: string,
  attemptId: string,
  ownerEmail: string,
  env: ProjectMediaEnv,
): Promise<string | null> {
  if (!isUuid(publicationId) || !isUuid(attemptId)) return null;
  const row = await findOwnedMedia(
    projectId,
    assetId,
    ownerEmail,
    env.PROJECTS_DB,
  );
  if (!row || row.validation_status !== "valid") return null;
  return signCapability(
    {
      version: 1,
      purpose: "project-media-render",
      publicationId,
      attemptId,
      projectId,
      assetId,
      objectKey: row.object_key,
      sha256: row.sha256,
      byteSize: row.byte_size,
      mediaType: row.media_type,
      expiresAt: Math.floor(Date.now() / 1000) + capabilityTtlSeconds,
    },
    env.PREVIEW_SIGNING_KEY,
  );
}

export async function getProjectMediaByCapability(
  assetId: string,
  token: string,
  env: ProjectMediaEnv,
): Promise<Response> {
  const capability = await verifyCapability(token, env.PREVIEW_SIGNING_KEY);
  if (
    !capability ||
    capability.assetId !== assetId ||
    capability.expiresAt <= Math.floor(Date.now() / 1000)
  ) {
    return notFound();
  }

  let row: MediaRow | null;
  try {
    row = await env.PROJECTS_DB.prepare(
      `SELECT id, project_id, kind, file_name, media_type, byte_size,
        object_key, sha256, validation_status, validation_error,
        decoded_duration_ms, created_at
       FROM project_media_assets
       WHERE id = ? AND project_id = ? AND object_key = ? AND sha256 = ?
         AND byte_size = ? AND media_type = ?
          AND ((? = 'project-media-render' AND validation_status = 'valid')
            OR (? = 'project-media-validation' AND kind = 'audio'
              AND validation_status = 'pending'))`,
    )
      .bind(
        capability.assetId,
        capability.projectId,
        capability.objectKey,
        capability.sha256,
        capability.byteSize,
        capability.mediaType,
        capability.purpose,
        capability.purpose,
      )
      .first<MediaRow>();
  } catch (error) {
    return platformFailure("Could not load the media asset", error);
  }
  return row ? storedMediaResponse(row, env.PROJECT_MEDIA) : notFound();
}

async function createValidationCapability(
  row: MediaRow,
  publicationId: string,
  attemptId: string,
  signingKey: string,
): Promise<string> {
  return signCapability(
    {
      version: 1,
      purpose: "project-media-validation",
      publicationId,
      attemptId,
      projectId: row.project_id,
      assetId: row.id,
      objectKey: row.object_key,
      sha256: row.sha256,
      byteSize: row.byte_size,
      mediaType: row.media_type,
      expiresAt: Math.floor(Date.now() / 1000) + capabilityTtlSeconds,
    },
    signingKey,
  );
}

export function projectMediaCapabilityUrl(
  assetId: string,
  configuredOrigin: string,
): string {
  const origin = configuredMediaOrigin(configuredOrigin);
  if (!origin) throw new Error("STUDIO_ORIGIN must be an HTTPS origin");
  return new URL(
    `/api/internal/project-media/${encodeURIComponent(assetId)}`,
    origin,
  ).toString();
}

function configuredMediaOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const localDevelopmentOrigin =
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]");
    if (
      (!localDevelopmentOrigin && url.protocol !== "https:") ||
      url.origin !== value ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

async function storedMediaResponse(
  row: MediaRow,
  bucket: R2Bucket,
): Promise<Response> {
  try {
    const object = await bucket.get(row.object_key);
    if (
      !object ||
      !("body" in object) ||
      object.size !== row.byte_size ||
      object.httpMetadata?.contentType !== row.media_type ||
      object.customMetadata?.projectId !== row.project_id ||
      object.customMetadata?.assetId !== row.id ||
      object.customMetadata?.kind !== row.kind ||
      object.customMetadata?.sha256 !== row.sha256 ||
      !object.checksums.sha256 ||
      hex(new Uint8Array(object.checksums.sha256)) !== row.sha256
    ) {
      return notFound();
    }
    return new Response(object.body, {
      headers: {
        "cache-control": "private, no-store",
        "content-length": String(row.byte_size),
        "content-type": row.media_type,
        "x-content-sha256": row.sha256,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return platformFailure("Could not load the media asset", error);
  }
}

async function findOwnedMedia(
  projectId: string,
  assetId: string,
  ownerEmail: string,
  database: D1Database,
): Promise<MediaRow | null> {
  if (!isUuid(projectId) || !isUuid(assetId)) return null;
  return database
    .prepare(
      `SELECT a.id, a.project_id, a.kind, a.file_name, a.media_type,
        a.byte_size, a.object_key, a.sha256, a.validation_status,
        a.validation_error, a.decoded_duration_ms, a.created_at
       FROM project_media_assets a
       JOIN projects p ON p.id = a.project_id
       WHERE a.id = ? AND a.project_id = ?
         AND a.owner_email = ? AND p.owner_email = ?`,
    )
    .bind(assetId, projectId, ownerEmail, ownerEmail)
    .first<MediaRow>();
}

async function ownsProject(
  projectId: string,
  ownerEmail: string,
  database: D1Database,
): Promise<boolean> {
  return Boolean(
    await database
      .prepare("SELECT id FROM projects WHERE id = ? AND owner_email = ?")
      .bind(projectId, ownerEmail)
      .first<{ id: string }>(),
  );
}

function metadataFromRow(row: MediaRow): ProjectMediaMetadata {
  const common = {
    id: row.id,
    projectId: row.project_id,
    fileName: row.file_name,
    byteSize: row.byte_size,
    sha256: row.sha256,
    validationStatus: row.validation_status,
    validationError: row.validation_error,
    createdAt: row.created_at,
  };
  return projectMediaAssetSchema.parse(
    row.kind === "audio"
      ? {
          ...common,
          kind: "audio",
          mediaType: row.media_type,
          decodedDurationMs: row.decoded_duration_ms,
        }
      : {
          ...common,
          kind: "captions",
          mediaType: row.media_type,
          language: "en",
        },
  );
}

function validateAudio(file: File, bytes: Uint8Array): boolean {
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  if (extension === "mp3" && file.type === "audio/mpeg") {
    return validateMp3(bytes);
  }
  if (extension === "wav" && file.type === "audio/wav") {
    return validateWav(bytes);
  }
  if (extension === "m4a" && file.type === "audio/mp4") {
    return validateM4a(bytes);
  }
  return false;
}

function validateMp3(bytes: Uint8Array): boolean {
  let offset = 0;
  if (ascii(bytes, 0, 3) === "ID3") {
    if (bytes.byteLength < 10 || bytes[3] === 0xff || bytes[4] === 0xff) {
      return false;
    }
    const sizeBytes = bytes.subarray(6, 10);
    if (sizeBytes.some((byte) => byte > 0x7f)) return false;
    const tagSize =
      (sizeBytes[0]! << 21) |
      (sizeBytes[1]! << 14) |
      (sizeBytes[2]! << 7) |
      sizeBytes[3]!;
    offset = 10 + tagSize + (bytes[5]! & 0x10 ? 10 : 0);
  }

  let frames = 0;
  while (offset + 4 <= bytes.byteLength) {
    if (
      bytes.byteLength - offset === 128 &&
      ascii(bytes, offset, offset + 3) === "TAG"
    ) {
      offset = bytes.byteLength;
      break;
    }
    const header = mp3Frame(bytes, offset);
    if (!header || offset + header > bytes.byteLength) return false;
    offset += header;
    frames += 1;
  }
  return frames > 0 && offset === bytes.byteLength;
}

function mp3Frame(bytes: Uint8Array, offset: number): number | undefined {
  const b1 = bytes[offset]!;
  const b2 = bytes[offset + 1]!;
  const b3 = bytes[offset + 2]!;
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) return undefined;
  const versionBits = (b2 >> 3) & 3;
  const layerBits = (b2 >> 1) & 3;
  const bitrateIndex = (b3 >> 4) & 15;
  const sampleIndex = (b3 >> 2) & 3;
  if (
    versionBits === 1 ||
    layerBits !== 1 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    sampleIndex === 3
  ) {
    return undefined;
  }
  const version1 = versionBits === 3;
  const bitrate = (
    version1
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  )[bitrateIndex]!;
  const baseSampleRate = [44_100, 48_000, 32_000][sampleIndex]!;
  const sampleRate =
    versionBits === 3
      ? baseSampleRate
      : versionBits === 2
        ? baseSampleRate / 2
        : baseSampleRate / 4;
  return (
    Math.floor(((version1 ? 144 : 72) * bitrate * 1000) / sampleRate) +
    ((b3 >> 1) & 1)
  );
}

function validateWav(bytes: Uint8Array): boolean {
  if (
    bytes.byteLength < 44 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 12) !== "WAVE"
  ) {
    return false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== bytes.byteLength - 8) return false;
  let offset = 12;
  let sawFormat = false;
  let sawData = false;
  while (offset + 8 <= bytes.byteLength) {
    const name = ascii(bytes, offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size;
    if (end > bytes.byteLength) return false;
    if (name === "fmt ") {
      if (sawFormat || sawData || size < 16) return false;
      const format = view.getUint16(offset + 8, true);
      const channels = view.getUint16(offset + 10, true);
      const sampleRate = view.getUint32(offset + 12, true);
      const byteRate = view.getUint32(offset + 16, true);
      const blockAlign = view.getUint16(offset + 20, true);
      if (
        ![1, 3, 6, 7, 0xfffe].includes(format) ||
        channels < 1 ||
        channels > 32 ||
        sampleRate < 8_000 ||
        sampleRate > 384_000 ||
        byteRate === 0 ||
        blockAlign === 0
      ) {
        return false;
      }
      sawFormat = true;
    } else if (name === "data") {
      if (!sawFormat || sawData || size === 0) return false;
      sawData = true;
    }
    offset = end + (size & 1);
  }
  return sawFormat && sawData && offset === bytes.byteLength;
}

function validateM4a(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 24) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let sawFtyp = false;
  let sawMoov = false;
  let sawMdat = false;
  while (offset + 8 <= bytes.byteLength) {
    let size = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.byteLength) return false;
      const largeSize = view.getBigUint64(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      size = Number(largeSize);
      headerSize = 16;
    } else if (size === 0) {
      size = bytes.byteLength - offset;
    }
    if (size < headerSize || offset + size > bytes.byteLength) return false;
    if (offset === 0 && type !== "ftyp") return false;
    if (type === "ftyp") {
      if (
        sawFtyp ||
        size < headerSize + 8 ||
        (size - headerSize - 8) % 4 !== 0
      ) {
        return false;
      }
      const brands = [
        ascii(bytes, offset + headerSize, offset + headerSize + 4),
      ];
      for (
        let index = offset + headerSize + 8;
        index + 4 <= offset + size;
        index += 4
      ) {
        brands.push(ascii(bytes, index, index + 4));
      }
      if (
        !brands.some((brand) =>
          ["M4A ", "M4B ", "isom", "mp42"].includes(brand),
        )
      ) {
        return false;
      }
      sawFtyp = true;
    } else if (type === "moov") {
      if (!validBoxChildren(bytes, offset + headerSize, offset + size)) {
        return false;
      }
      sawMoov = true;
    } else if (type === "mdat" && size > headerSize) {
      sawMdat = true;
    }
    offset += size;
  }
  return sawFtyp && sawMoov && sawMdat && offset === bytes.byteLength;
}

function validBoxChildren(
  bytes: Uint8Array,
  start: number,
  end: number,
): boolean {
  if (start + 8 > end) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start;
  while (offset + 8 <= end) {
    const size = view.getUint32(offset);
    if (size < 8 || offset + size > end) return false;
    offset += size;
  }
  return offset === end;
}

function validateCaptions(file: File, bytes: Uint8Array): boolean {
  return (
    file.name.toLowerCase().endsWith(".vtt") &&
    file.type === "text/vtt" &&
    validateWebVtt(bytes)
  );
}

export function validateWebVtt(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (text.startsWith("\ufeff")) text = text.slice(1);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    ) {
      return false;
    }
  }
  const lines = text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  if (
    lines.length > maxWebVttLines ||
    !/^WEBVTT(?:[ \t](?:(?!-->).)*)?$/.test(lines[0] ?? "")
  ) {
    return false;
  }
  let index = 1;
  if (lines[index] !== "") return false;
  while (lines[index] === "") index += 1;
  let cueCount = 0;
  let blockCount = 0;
  let sawCue = false;
  while (index < lines.length) {
    blockCount += 1;
    if (blockCount > maxWebVttBlocks) return false;
    const block: string[] = [];
    while (index < lines.length && lines[index] !== "") {
      block.push(lines[index++]!);
    }
    while (lines[index] === "") index += 1;
    if (block.length === 0) continue;
    if (
      block[0]!.startsWith("NOTE") &&
      /^(?:NOTE|NOTE[ \t].*)$/.test(block[0]!)
    ) {
      continue;
    }
    if (block[0] === "STYLE" || block[0] === "REGION") {
      if (sawCue || block.length < 2) return false;
      continue;
    }
    const timingIndex = block[0]!.includes("-->") ? 0 : 1;
    if (timingIndex === 1 && (block.length < 3 || block[0]!.includes("-->"))) {
      return false;
    }
    if (!validCueTiming(block[timingIndex]!)) return false;
    const payload = block.slice(timingIndex + 1);
    if (
      payload.length === 0 ||
      payload.some((line) => line.includes("-->")) ||
      payload.join("\n").length > 64 * 1024
    ) {
      return false;
    }
    cueCount += 1;
    sawCue = true;
  }
  return cueCount > 0;
}

function validCueTiming(line: string): boolean {
  const match = /^(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t]+(.+))?$/.exec(line);
  if (!match) return false;
  const start = parseWebVttTimestamp(match[1]!);
  const end = parseWebVttTimestamp(match[2]!);
  if (
    start === undefined ||
    end === undefined ||
    start >= end ||
    end > maxWebVttTimestampMs
  ) {
    return false;
  }
  const settings = match[3]?.split(/[ \t]+/) ?? [];
  const seen = new Set<string>();
  for (const setting of settings) {
    const separator = setting.indexOf(":");
    if (separator <= 0 || separator === setting.length - 1) return false;
    const name = setting.slice(0, separator);
    const value = setting.slice(separator + 1);
    if (seen.has(name) || !validCueSetting(name, value)) return false;
    seen.add(name);
  }
  return true;
}

function validCueSetting(name: string, value: string): boolean {
  if (name === "vertical") return value === "rl" || value === "lr";
  if (name === "align")
    return ["start", "center", "end", "left", "right"].includes(value);
  if (name === "size") return validPercentage(value);
  if (name === "position") {
    const [coordinate, anchor, extra] = value.split(",");
    return (
      extra === undefined &&
      validPercentage(coordinate!) &&
      (anchor === undefined ||
        ["line-left", "center", "line-right", "auto"].includes(anchor))
    );
  }
  if (name === "line") {
    const [coordinate, anchor, extra] = value.split(",");
    return (
      extra === undefined &&
      (coordinate === "auto" ||
        /^-?\d+$/.test(coordinate!) ||
        validPercentage(coordinate!)) &&
      (anchor === undefined || ["start", "center", "end"].includes(anchor))
    );
  }
  return false;
}

function validPercentage(value: string): boolean {
  const match = /^(\d{1,3}(?:\.\d+)?)%$/.exec(value);
  return Boolean(match && Number(match[1]) <= 100);
}

function parseWebVttTimestamp(value: string): number | undefined {
  const match = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(value);
  if (!match) return undefined;
  const hours = Number(match[1] ?? 0);
  return (
    ((hours * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 +
    Number(match[4])
  );
}

async function readLimitedBytes(
  request: Request,
  limit: number,
): Promise<ArrayBuffer> {
  const reader = request.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new MediaTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function signCapability(
  capability: MediaCapability,
  secret: string,
): Promise<string> {
  const payload = base64Url(
    new TextEncoder().encode(JSON.stringify(capability)),
  );
  const signature = await hmac(payload, secret, "sign");
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

async function verifyCapability(
  token: string,
  secret: string,
): Promise<MediaCapability | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const payload = parts[0];
  const signature = parts[1];
  if (!payload || !signature) return null;
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = fromBase64Url(signature);
  } catch {
    return null;
  }
  if (!(await hmac(payload, secret, "verify", ownedBuffer(signatureBytes))))
    return null;
  try {
    const value = mediaCapabilitySchema.safeParse(
      JSON.parse(new TextDecoder().decode(fromBase64Url(payload))),
    );
    return value.success ? value.data : null;
  } catch {
    return null;
  }
}

async function hmac(
  payload: string,
  secret: string,
  operation: "sign",
): Promise<ArrayBuffer>;
async function hmac(
  payload: string,
  secret: string,
  operation: "verify",
  signature: ArrayBuffer,
): Promise<boolean>;
async function hmac(
  payload: string,
  secret: string,
  operation: "sign" | "verify",
  signature?: ArrayBuffer,
): Promise<ArrayBuffer | boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`project-media-v1:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [operation],
  );
  const data = new TextEncoder().encode(payload);
  if (operation === "sign") return crypto.subtle.sign("HMAC", key, data);
  if (!signature) throw new Error("HMAC signature is required");
  return crypto.subtle.verify("HMAC", key, signature, data);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", ownedBuffer(bytes)),
  );
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function cleanupObject(key: string, bucket: R2Bucket): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await bucket.delete(key);
      return;
    } catch (error) {
      if (attempt === 2) {
        console.error(
          JSON.stringify({
            message: "Could not clean up an uncommitted media asset",
            key,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  }
}

function validFileName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  );
}

function invalidUpload(kind: ProjectMediaKind): Response {
  return Response.json({ error: `Invalid ${kind} upload` }, { status: 400 });
}

function tooLarge(message: string): Response {
  return Response.json({ error: message }, { status: 413 });
}

function notFound(): Response {
  return Response.json({ error: "Media asset not found" }, { status: 404 });
}

class MediaTooLargeError extends Error {}
