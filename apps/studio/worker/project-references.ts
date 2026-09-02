import {
  createReferenceUploadRequestSchema,
  referenceImageMaxBytes,
  referenceImageMaxDimension,
  referenceImageMaxPixels,
  referenceMetadataSchema,
} from "@programmable-video/contracts";
import { inflateSync } from "node:zlib";
import { z } from "zod";

import { multipartOverheadBytes } from "./worker-constants";
import { base64Url, isUuid, platformFailure } from "./worker-utils";

const maxPngChunks = 512;
const maxImageDataChunks = 256;
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const formTextSchema = z.string();
const inflatedPngSchema = z.object({
  buffer: z.instanceof(Uint8Array),
  engine: z.object({ bytesWritten: z.number() }),
});

export interface ProjectReferenceEnv {
  PROJECTS_DB: D1Database;
  PROJECT_REFERENCES: R2Bucket;
}

export interface AgentReferenceEnv extends ProjectReferenceEnv {
  PREVIEW_SIGNING_KEY: string;
  STUDIO_ORIGIN: string;
}

interface UploadedReferenceRow {
  id: string;
  file_name: string;
  media_type: "image/png";
  byte_size: number;
  note: string;
  object_key: string;
  sha256: string;
  width: number;
  height: number;
  created_at: string;
}

const agentReferenceCapabilitySchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal("agent-reference"),
    projectId: z.uuid(),
    referenceId: z.uuid(),
    objectKey: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    byteSize: z.number().int().positive().max(referenceImageMaxBytes),
    mediaType: z.literal("image/png"),
    expiresAt: z.number().int().positive(),
  })
  .strict();

type AgentReferenceCapability = z.infer<typeof agentReferenceCapabilitySchema>;

export async function createAgentReferenceDownloads(
  projectId: string,
  ownerEmail: string,
  expiresAt: string,
  env: AgentReferenceEnv,
) {
  const expiration = Math.floor(new Date(expiresAt).getTime() / 1000);
  if (!Number.isFinite(expiration) || expiration <= 0) {
    throw new Error("Agent handoff expiry is invalid");
  }
  const origin = configuredReferenceOrigin(env.STUDIO_ORIGIN);
  if (!origin) {
    throw new Error("STUDIO_ORIGIN must be an HTTPS origin");
  }
  const rows = await env.PROJECTS_DB.prepare(
    `SELECT r.id, r.file_name, r.media_type, r.byte_size, r.note,
      r.object_key, r.sha256, r.width, r.height, r.created_at
     FROM project_references r
     JOIN projects p ON p.id = r.project_id
     WHERE r.project_id = ? AND r.storage_state = 'uploaded'
       AND p.owner_email = ?
     ORDER BY r.created_at ASC`,
  )
    .bind(projectId, ownerEmail)
    .all<UploadedReferenceRow>();

  return Promise.all(
    rows.results.map(async (row) => ({
      id: row.id,
      fileName: row.file_name,
      downloadUrl: new URL(
        `/api/internal/project-references/${encodeURIComponent(row.id)}`,
        origin,
      ).toString(),
      token: await signAgentReferenceCapability(
        {
          version: 1,
          purpose: "agent-reference",
          projectId,
          referenceId: row.id,
          objectKey: row.object_key,
          sha256: row.sha256,
          byteSize: row.byte_size,
          mediaType: row.media_type,
          expiresAt: expiration,
        },
        env.PREVIEW_SIGNING_KEY,
      ),
      sha256: row.sha256,
    })),
  );
}

function configuredReferenceOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
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

export async function getReferenceByCapability(
  referenceId: string,
  token: string,
  env: AgentReferenceEnv,
): Promise<Response> {
  const capability = await verifyAgentReferenceCapability(
    token,
    env.PREVIEW_SIGNING_KEY,
  );
  if (
    !capability ||
    capability.referenceId !== referenceId ||
    capability.expiresAt <= Math.floor(Date.now() / 1000)
  ) {
    return notFound();
  }
  let row: UploadedReferenceRow | null;
  try {
    row = await env.PROJECTS_DB.prepare(
      `SELECT id, file_name, media_type, byte_size, note, object_key, sha256,
        width, height, created_at
       FROM project_references
       WHERE id = ? AND project_id = ? AND storage_state = 'uploaded'
         AND object_key = ? AND sha256 = ? AND byte_size = ? AND media_type = ?`,
    )
      .bind(
        capability.referenceId,
        capability.projectId,
        capability.objectKey,
        capability.sha256,
        capability.byteSize,
        capability.mediaType,
      )
      .first<UploadedReferenceRow>();
  } catch (error) {
    return platformFailure("Could not load the visual reference", error);
  }
  return row
    ? storedReferenceResponse(row, capability.projectId, env.PROJECT_REFERENCES)
    : notFound();
}

export async function createReferenceUpload(
  request: Request,
  projectId: string,
  ownerEmail: string,
  env: ProjectReferenceEnv,
): Promise<Response> {
  let owned: boolean;
  try {
    owned = await ownsProject(projectId, ownerEmail, env.PROJECTS_DB);
  } catch (error) {
    return platformFailure("Could not load the product project", error);
  }
  if (!owned) {
    return notFound();
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > referenceImageMaxBytes + multipartOverheadBytes
  ) {
    return Response.json(
      { error: "Reference image exceeds 10 MiB" },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    const body = await readLimitedBytes(
      request,
      referenceImageMaxBytes + multipartOverheadBytes,
    );
    form = await new Request(request.url, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      body,
    }).formData();
  } catch (error) {
    if (error instanceof ReferenceTooLargeError) {
      return Response.json(
        { error: "Reference image exceeds 10 MiB" },
        { status: 413 },
      );
    }
    return invalidRequest();
  }
  if (
    [...form.keys()].some(
      (key) => key !== "file" && key !== "representedState",
    ) ||
    form.getAll("file").length !== 1 ||
    form.getAll("representedState").length !== 1
  ) {
    return invalidRequest();
  }

  const file = form.get("file");
  const representedState = form.get("representedState");
  const representedStateText = formTextSchema.safeParse(representedState);
  if (!(file instanceof File) || !representedStateText.success) {
    return invalidRequest();
  }
  const parsed = createReferenceUploadRequestSchema.safeParse({
    representedState: representedStateText.data,
  });
  if (!parsed.success || !validFileName(file.name)) return invalidRequest();
  if (file.size > referenceImageMaxBytes) {
    return Response.json(
      { error: "Reference image exceeds 10 MiB" },
      { status: 413 },
    );
  }
  if (file.size === 0 || file.type !== "image/png") {
    return Response.json(
      { error: "Reference must be a PNG image" },
      { status: 400 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const dimensions = validatePng(bytes);
  if (!dimensions) {
    return Response.json(
      { error: "Reference must be a valid PNG image" },
      { status: 400 },
    );
  }
  if (
    dimensions.width > referenceImageMaxDimension ||
    dimensions.height > referenceImageMaxDimension ||
    dimensions.width * dimensions.height > referenceImageMaxPixels
  ) {
    return Response.json(
      { error: "Reference image dimensions are too large" },
      { status: 400 },
    );
  }

  const id = crypto.randomUUID();
  const sha256 = await digestHex(bytes);
  const objectKey = `projects/${projectId}/references/${id}/original.png`;
  const createdAt = new Date().toISOString();
  const reference = referenceMetadataSchema.parse({
    id,
    fileName: file.name,
    mediaType: "image/png",
    byteSize: file.size,
    note: parsed.data.representedState,
    storageState: "uploaded",
    width: dimensions.width,
    height: dimensions.height,
    createdAt,
  });
  if (reference.storageState !== "uploaded") {
    throw new Error("Uploaded reference contract mismatch");
  }

  try {
    const stored = await env.PROJECT_REFERENCES.put(objectKey, bytes, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { projectId, referenceId: id, sha256 },
    });
    if (!stored) throw new Error("R2 did not store the reference image");
  } catch (error) {
    return platformFailure("Could not store the visual reference", error);
  }

  try {
    await env.PROJECTS_DB.prepare(
      `INSERT INTO project_references (
        id, project_id, file_name, media_type, byte_size, note, storage_state,
        object_key, sha256, width, height, created_at
      ) VALUES (?, ?, ?, 'image/png', ?, ?, 'uploaded', ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        projectId,
        reference.fileName,
        reference.byteSize,
        reference.note,
        objectKey,
        sha256,
        reference.width,
        reference.height,
        createdAt,
      )
      .run();
  } catch (error) {
    await cleanupObject(objectKey, env.PROJECT_REFERENCES);
    return platformFailure("Could not save the visual reference", error);
  }

  return Response.json(reference, { status: 201 });
}

export async function getReferenceContent(
  projectId: string,
  referenceId: string,
  ownerEmail: string,
  env: ProjectReferenceEnv,
): Promise<Response> {
  if (!isUuid(projectId) || !isUuid(referenceId)) return notFound();

  let row: UploadedReferenceRow | null;
  try {
    row = await env.PROJECTS_DB.prepare(
      `SELECT r.id, r.file_name, r.media_type, r.byte_size, r.note,
        r.object_key, r.sha256, r.width, r.height, r.created_at
       FROM project_references r
       JOIN projects p ON p.id = r.project_id
       WHERE r.id = ? AND r.project_id = ? AND r.storage_state = 'uploaded'
         AND p.owner_email = ?`,
    )
      .bind(referenceId, projectId, ownerEmail)
      .first<UploadedReferenceRow>();
  } catch (error) {
    return platformFailure("Could not load the visual reference", error);
  }
  if (!row) return notFound();

  return storedReferenceResponse(row, projectId, env.PROJECT_REFERENCES);
}

async function storedReferenceResponse(
  row: UploadedReferenceRow,
  projectId: string,
  bucket: R2Bucket,
): Promise<Response> {
  try {
    const object = await bucket.get(row.object_key);
    if (
      !object ||
      !("body" in object) ||
      object.size !== row.byte_size ||
      object.httpMetadata?.contentType !== row.media_type ||
      object.customMetadata?.projectId !== projectId ||
      object.customMetadata?.referenceId !== row.id ||
      object.customMetadata?.sha256 !== row.sha256
    ) {
      return notFound();
    }
    return new Response(object.body, {
      headers: {
        "cache-control": "private, no-store",
        "content-length": String(row.byte_size),
        "content-type": row.media_type,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return platformFailure("Could not load the visual reference", error);
  }
}

async function signAgentReferenceCapability(
  capability: AgentReferenceCapability,
  secret: string,
): Promise<string> {
  const payload = base64Url(
    new TextEncoder().encode(JSON.stringify(capability)),
  );
  const signature = await referenceHmac(payload, secret, "sign");
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

async function verifyAgentReferenceCapability(
  token: string,
  secret: string,
): Promise<AgentReferenceCapability | null> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = fromBase64Url(signature);
  } catch {
    return null;
  }
  if (
    !(await referenceHmac(
      payload,
      secret,
      "verify",
      ownedBuffer(signatureBytes),
    ))
  ) {
    return null;
  }
  try {
    const parsed = agentReferenceCapabilitySchema.safeParse(
      JSON.parse(new TextDecoder().decode(fromBase64Url(payload))),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function referenceHmac(
  payload: string,
  secret: string,
  operation: "sign",
): Promise<ArrayBuffer>;
async function referenceHmac(
  payload: string,
  secret: string,
  operation: "verify",
  signature: ArrayBuffer,
): Promise<boolean>;
async function referenceHmac(
  payload: string,
  secret: string,
  operation: "sign" | "verify",
  signature?: ArrayBuffer,
): Promise<ArrayBuffer | boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`agent-reference-v1:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [operation],
  );
  const data = new TextEncoder().encode(payload);
  if (operation === "sign") return crypto.subtle.sign("HMAC", key, data);
  if (!signature) throw new Error("HMAC signature is required");
  return crypto.subtle.verify("HMAC", key, signature, data);
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

async function ownsProject(
  projectId: string,
  ownerEmail: string,
  database: D1Database,
): Promise<boolean> {
  if (!isUuid(projectId)) return false;
  return Boolean(
    await database
      .prepare("SELECT id FROM projects WHERE id = ? AND owner_email = ?")
      .bind(projectId, ownerEmail)
      .first<{ id: string }>(),
  );
}

function validatePng(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  if (bytes.byteLength < 45) return undefined;
  if (pngSignature.some((value, index) => bytes[index] !== value))
    return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitsPerPixel = 0;
  let imageColorType = 0;
  let sawHeader = false;
  let sawPalette = false;
  let sawImageData = false;
  let imageDataEnded = false;
  let sawEnd = false;
  let chunkCount = 0;
  const imageData: Uint8Array[] = [];

  while (offset < bytes.byteLength) {
    chunkCount += 1;
    if (chunkCount > maxPngChunks) return undefined;
    if (offset + 12 > bytes.byteLength) return undefined;
    const length = view.getUint32(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > bytes.byteLength) return undefined;
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    );
    if (
      crc32(bytes.subarray(offset + 4, dataEnd)) !== view.getUint32(dataEnd)
    ) {
      return undefined;
    }

    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) return undefined;
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      const bitDepth = bytes[dataStart + 8]!;
      const colorType = bytes[dataStart + 9]!;
      const channels = channelsFor(colorType, bitDepth);
      if (
        width === 0 ||
        height === 0 ||
        channels === 0 ||
        bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 ||
        bytes[dataStart + 12] !== 0
      ) {
        return undefined;
      }
      bitsPerPixel = channels * bitDepth;
      imageColorType = colorType;
      sawHeader = true;
    } else if (type === "IHDR") {
      return undefined;
    } else if (type === "PLTE") {
      if (sawImageData || length === 0 || length % 3 !== 0 || length > 768) {
        return undefined;
      }
      sawPalette = true;
    } else if (type === "IDAT") {
      if (imageDataEnded || imageData.length >= maxImageDataChunks) {
        return undefined;
      }
      sawImageData = true;
      imageData.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      if (length !== 0 || !sawImageData || chunkEnd !== bytes.byteLength) {
        return undefined;
      }
      sawEnd = true;
      break;
    } else if (type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90) {
      return undefined;
    } else if (sawImageData) {
      imageDataEnded = true;
    }
    offset = chunkEnd;
  }

  if (!sawHeader || !sawImageData || !sawEnd) return undefined;
  if (imageColorType === 3 && !sawPalette) return undefined;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8) + 1;
  const expectedBytes = rowBytes * height;
  if (expectedBytes > 64 * 1024 * 1024) return undefined;
  const compressed = concatenate(imageData);
  try {
    const inflated = inflatedPngSchema.parse(
      inflateSync(compressed, {
        info: true,
        maxOutputLength: expectedBytes,
      }),
    );
    const decoded = inflated.buffer;
    if (inflated.engine.bytesWritten !== compressed.byteLength)
      return undefined;
    if (decoded.byteLength !== expectedBytes) return undefined;
    for (let row = 0; row < height; row += 1) {
      if (decoded[row * rowBytes]! > 4) return undefined;
    }
  } catch {
    return undefined;
  }
  return { width, height };
}

function channelsFor(colorType: number, bitDepth: number): number {
  if (colorType === 0) return [1, 2, 4, 8, 16].includes(bitDepth) ? 1 : 0;
  if (colorType === 2) return [8, 16].includes(bitDepth) ? 3 : 0;
  if (colorType === 3) return [1, 2, 4, 8].includes(bitDepth) ? 1 : 0;
  if (colorType === 4) return [8, 16].includes(bitDepth) ? 2 : 0;
  if (colorType === 6) return [8, 16].includes(bitDepth) ? 4 : 0;
  return 0;
}

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
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
      throw new ReferenceTooLargeError();
    }
    chunks.push(value);
  }
  const result = new ArrayBuffer(size);
  const bytes = new Uint8Array(result);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
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
            message: "Could not clean up an uncommitted visual reference",
            key,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  }
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validFileName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  );
}

function invalidRequest(): Response {
  return Response.json({ error: "Invalid reference upload" }, { status: 400 });
}

function notFound(): Response {
  return Response.json({ error: "Reference not found" }, { status: 404 });
}

class ReferenceTooLargeError extends Error {}
