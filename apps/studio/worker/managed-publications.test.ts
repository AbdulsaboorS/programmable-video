import { createNoOpFinishingSpec } from "@programmable-video/contracts";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createManagedPublication,
  getManagedPublication,
  publicationFileName,
  reservePublicationStreamUpload,
  retryManagedPublication,
  type PublicationWorkflowTarget,
} from "./managed-publications";

const projectId = "0198c7d4-a5e6-7000-8000-000000000000";
const revisionId = "0198c7d4-a5e6-7000-8000-000000000001";
const owner = "creator@example.com";
const manifestDigest = "a".repeat(64);
const inputDigest = "b".repeat(64);

interface PublicationRecord {
  id: string;
  project_id: string;
  revision_id: string;
  owner_email: string;
  idempotency_key: string;
  build_attempt: number;
  manifest_digest: string;
  input_digest: string;
  finishing_spec_json: string;
  finishing_spec_digest: string;
  created_at: string;
}

interface AttemptRecord {
  id: string;
  publication_id: string;
  attempt: number;
  status: "queued" | "rendering" | "ready" | "failed";
  error_message: string | null;
  stream_video_id: string | null;
  stream_upload_url: string | null;
  playback_status: "pending" | "processing" | "ready" | "failed";
  player_url: string | null;
  hls_url: string | null;
  caption_status:
    "not_requested" | "pending" | "processing" | "ready" | "failed";
  caption_error: string | null;
  thumbnail_url: string | null;
  download_status:
    "not_requested" | "pending" | "processing" | "ready" | "failed";
  download_percent: number | null;
  download_url: string | null;
  download_error: string | null;
  created_at: string;
  updated_at: string;
}

class FakeDatabase {
  publications: PublicationRecord[] = [];
  attempts: AttemptRecord[] = [];
  assets = new Map<string, { kind: "audio" | "captions"; sha256: string }>();
  owner = owner;
  attemptInsertFailure?: () => void;
  reservationRace?: () => void;

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    return new FakeStatement(this, normalized);
  }

  async batch(statements: FakeStatement[]) {
    for (const statement of statements) await statement.run();
    return statements.map(() => ({ success: true }));
  }
}

class FakeStatement {
  values: unknown[] = [];

  constructor(
    private readonly database: FakeDatabase,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first() {
    if (
      this.sql.includes("SELECT stream_video_id, stream_upload_url") &&
      this.sql.includes("FROM managed_publication_attempts")
    ) {
      const attempt = this.database.attempts.find(
        (candidate) =>
          candidate.id === this.values[0] &&
          candidate.stream_video_id &&
          candidate.stream_upload_url,
      );
      return attempt
        ? {
            stream_video_id: attempt.stream_video_id,
            stream_upload_url: attempt.stream_upload_url,
          }
        : null;
    }
    if (
      this.sql.includes("FROM projects p") &&
      this.sql.includes("revision_approvals")
    ) {
      return this.database.owner === this.values[1]
        ? {
            project_id: projectId,
            revision_id: revisionId,
            attempt: 1,
            manifest_digest: manifestDigest,
            input_digest: inputDigest,
            fps: 30,
            duration_in_frames: 360,
          }
        : null;
    }
    if (this.sql.startsWith("SELECT id FROM projects")) {
      return this.values[0] === projectId &&
        this.values[1] === this.database.owner
        ? { id: projectId }
        : null;
    }
    if (this.sql.includes("FROM project_media_assets")) {
      const assetId = z.string().parse(this.values[0]);
      const asset = this.database.assets.get(assetId);
      return asset
        ? {
            id: assetId,
            kind: asset.kind,
            sha256: asset.sha256,
            validation_status: "valid",
          }
        : null;
    }
    if (this.sql.includes("idempotency_key = ?")) {
      return (
        this.database.publications.find(
          (publication) =>
            publication.project_id === this.values[0] &&
            publication.owner_email === this.values[1] &&
            publication.idempotency_key === this.values[2],
        ) ?? null
      );
    }
    if (this.sql.includes("FROM managed_publications WHERE id = ?")) {
      return (
        this.database.publications.find(
          (publication) =>
            publication.id === this.values[0] &&
            publication.owner_email === this.values[1] &&
            (this.values.length < 3 ||
              publication.project_id === this.values[2]),
        ) ?? null
      );
    }
    throw new Error(`Unexpected first query: ${this.sql}`);
  }

  async all() {
    if (this.sql.includes("FROM managed_publication_attempts")) {
      return {
        results: this.database.attempts.filter(
          (attempt) => attempt.publication_id === this.values[0],
        ),
      };
    }
    throw new Error(`Unexpected all query: ${this.sql}`);
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO managed_publications")) {
      if (
        this.database.publications.some(
          (publication) =>
            publication.project_id === this.values[1] &&
            publication.idempotency_key === this.values[4],
        )
      ) {
        throw new Error("UNIQUE constraint failed");
      }
      const value = z
        .array(z.union([z.string(), z.number(), z.null()]))
        .parse(this.values);
      this.database.publications.push({
        id: z.string().parse(value[0]),
        project_id: z.string().parse(value[1]),
        revision_id: z.string().parse(value[2]),
        owner_email: z.string().parse(value[3]),
        idempotency_key: z.string().parse(value[4]),
        build_attempt: z.number().parse(value[5]),
        manifest_digest: z.string().parse(value[6]),
        input_digest: z.string().parse(value[7]),
        finishing_spec_json: z.string().parse(value[9]),
        finishing_spec_digest: z.string().parse(value[10]),
        created_at: z.string().parse(value[23]),
      });
      return { success: true };
    }
    if (this.sql.startsWith("INSERT INTO managed_publication_attempts")) {
      const retry = this.values.length === 17;
      if (retry && this.database.attemptInsertFailure) {
        this.database.attemptInsertFailure();
        throw new Error("attempt insert failed");
      }
      this.database.attempts.push(
        retry
          ? attemptRecord({
              id: z.string().parse(this.values[0]),
              publication_id: z.string().parse(this.values[1]),
              attempt: z.number().parse(this.values[2]),
              stream_video_id: z.string().nullable().parse(this.values[4]),
              playback_status: z
                .enum(["pending", "processing", "ready", "failed"])
                .parse(this.values[5]),
              player_url: z.string().nullable().parse(this.values[6]),
              hls_url: z.string().nullable().parse(this.values[7]),
              caption_status: z
                .enum([
                  "not_requested",
                  "pending",
                  "processing",
                  "ready",
                  "failed",
                ])
                .parse(this.values[8]),
              thumbnail_url: z.string().nullable().parse(this.values[10]),
              download_status: z
                .enum([
                  "not_requested",
                  "pending",
                  "processing",
                  "ready",
                  "failed",
                ])
                .parse(this.values[12]),
              download_url: z.string().nullable().parse(this.values[14]),
              created_at: z.string().parse(this.values[15]),
              updated_at: z.string().parse(this.values[16]),
            })
          : attemptRecord({
              id: z.string().parse(this.values[0]),
              publication_id: z.string().parse(this.values[1]),
              caption_status: z
                .enum([
                  "not_requested",
                  "pending",
                  "processing",
                  "ready",
                  "failed",
                ])
                .parse(this.values[3]),
              created_at: z.string().parse(this.values[4]),
              updated_at: z.string().parse(this.values[5]),
            }),
      );
      return { success: true };
    }
    if (this.sql.startsWith("UPDATE managed_publication_attempts")) {
      if (this.sql.includes("stream_video_id = ?")) {
        this.database.reservationRace?.();
        const attempt = this.database.attempts.find(
          (candidate) => candidate.id === this.values[3],
        );
        if (attempt && attempt.stream_video_id === null) {
          attempt.stream_video_id = z.string().parse(this.values[0]);
          attempt.stream_upload_url = z.string().parse(this.values[1]);
        }
      }
      return { success: true };
    }
    throw new Error(`Unexpected run query: ${this.sql}`);
  }
}

function attemptRecord(overrides: Partial<AttemptRecord>): AttemptRecord {
  const timestamp = "2026-08-26T12:00:00.000Z";
  return {
    id: crypto.randomUUID(),
    publication_id: "",
    attempt: 1,
    status: "queued",
    error_message: null,
    stream_video_id: null,
    stream_upload_url: null,
    playback_status: "pending",
    player_url: null,
    hls_url: null,
    caption_status: "not_requested",
    caption_error: null,
    thumbnail_url: null,
    download_status: "pending",
    download_percent: null,
    download_url: null,
    download_error: null,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function environment(database = new FakeDatabase()) {
  const create = vi.fn(async () => ({ id: "workflow" }));
  return {
    database,
    create,
    env: fromPartial<Env>({
      PROJECTS_DB: fromPartial<D1Database>(database),
      MANAGED_RENDER_WORKFLOW: { create },
    }),
  };
}

function publicationRequest(
  idempotencyKey: string,
  finishingSpec = createNoOpFinishingSpec(360),
) {
  return new Request("https://studio.example/publications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey, finishingSpec }),
  });
}

function validateProvenance() {
  return Promise.resolve(new Response(null, { status: 204 }));
}

describe("managed publications", () => {
  it("explains required Stream credentials before local publication", async () => {
    const { env, create } = environment();
    Object.assign(env, { LOCAL_OWNER_EMAIL: owner });

    const response = await createManagedPublication(
      publicationRequest("publish-local"),
      projectId,
      revisionId,
      owner,
      env,
      validateProvenance,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        "Add STREAM_ACCOUNT_ID and STREAM_API_TOKEN to apps/studio/.dev.vars before publishing",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("reuses a persisted Stream reservation when a Workflow step replays", async () => {
    const createDirectUpload = vi.fn();
    const database = new FakeDatabase();
    const target = {
      attemptId: "0198c7d4-a5e6-7000-8000-000000000030",
      publicationId: "0198c7d4-a5e6-7000-8000-000000000031",
      projectId,
      revisionId,
      ownerEmail: owner,
      commitSha: "f".repeat(40),
      projectName: "R&D / Launch Video",
      buildAttempt: 1,
      manifestDigest,
      inputDigest,
      previewPrefix: "preview",
      finishingSpec: createNoOpFinishingSpec(360),
      streamVideoId: null,
      streamUploadUrl: null,
      playbackStatus: "processing",
      playerUrl: null,
      hlsUrl: null,
      thumbnailUrl: null,
      captionStatus: "not_requested",
      downloadStatus: "pending",
    } satisfies PublicationWorkflowTarget;
    database.attempts.push(
      attemptRecord({
        id: target.attemptId,
        publication_id: target.publicationId,
        stream_video_id: "stream-existing",
        stream_upload_url: "https://upload.example/existing",
      }),
    );
    await expect(
      reservePublicationStreamUpload(
        target,
        fromPartial<StreamBinding>({ createDirectUpload }),
        fromPartial<D1Database>(database),
      ),
    ).resolves.toEqual({
      videoId: "stream-existing",
      uploadUrl: "https://upload.example/existing",
    });
    expect(createDirectUpload).not.toHaveBeenCalled();
    expect(publicationFileName(target.projectName, target.publicationId)).toBe(
      "r-d-launch-video-0198c7d4.mp4",
    );
  });

  it("returns the authoritative reservation after conditional persistence", async () => {
    const database = new FakeDatabase();
    const attempt = attemptRecord({
      id: "0198c7d4-a5e6-7000-8000-000000000030",
      publication_id: "0198c7d4-a5e6-7000-8000-000000000031",
    });
    database.attempts.push(attempt);
    database.reservationRace = () => {
      attempt.stream_video_id = "stream-winner";
      attempt.stream_upload_url = "https://upload.example/winner";
    };
    const createDirectUpload = vi.fn(async () => ({
      id: "stream-loser",
      uploadURL: "https://upload.example/loser",
    }));
    const staleTarget = {
      attemptId: attempt.id,
      publicationId: attempt.publication_id,
      projectId,
      revisionId,
      ownerEmail: owner,
      commitSha: "f".repeat(40),
      projectName: "Launch",
      buildAttempt: 1,
      manifestDigest,
      inputDigest,
      previewPrefix: "preview",
      finishingSpec: createNoOpFinishingSpec(360),
      streamVideoId: null,
      streamUploadUrl: null,
      playbackStatus: "pending",
      playerUrl: null,
      hlsUrl: null,
      thumbnailUrl: null,
      captionStatus: "not_requested",
      downloadStatus: "pending",
    } satisfies PublicationWorkflowTarget;

    await expect(
      reservePublicationStreamUpload(
        staleTarget,
        fromPartial<StreamBinding>({ createDirectUpload }),
        fromPartial<D1Database>(database),
      ),
    ).resolves.toEqual({
      videoId: "stream-winner",
      uploadUrl: "https://upload.example/winner",
    });
  });

  it("canonicalizes one publish intent and rejects changed input", async () => {
    const { env, database, create } = environment();
    const provenance = vi.fn(validateProvenance);
    const created = await createManagedPublication(
      publicationRequest("publish-1"),
      projectId,
      revisionId,
      owner,
      env,
      provenance,
    );
    expect(created.status).toBe(202);
    expect(create).toHaveBeenCalledOnce();
    expect(database.publications[0]?.finishing_spec_json).toBe(
      JSON.stringify(createNoOpFinishingSpec(360)),
    );
    expect(database.publications[0]?.finishing_spec_digest).toMatch(
      /^[0-9a-f]{64}$/,
    );

    const replay = await createManagedPublication(
      publicationRequest("publish-1"),
      projectId,
      revisionId,
      owner,
      env,
      provenance,
    );
    expect(replay.status).toBe(200);
    expect(create).toHaveBeenCalledOnce();
    expect(provenance).toHaveBeenCalledOnce();

    const changed = createNoOpFinishingSpec(360);
    changed.output.fit = "cover";
    const conflict = await createManagedPublication(
      publicationRequest("publish-1", changed),
      projectId,
      revisionId,
      owner,
      env,
      provenance,
    );
    expect(conflict.status).toBe(409);
    expect(provenance).toHaveBeenCalledOnce();
  });

  it("validates trim and digest-bound owned media against the approved build", async () => {
    const { env, database, create } = environment();
    const audioId = "0198c7d4-a5e6-7000-8000-000000000010";
    const digest = "c".repeat(64);
    database.assets.set(audioId, { kind: "audio", sha256: digest });
    const spec = createNoOpFinishingSpec(360);
    spec.audio = {
      asset: { id: audioId, sha256: "d".repeat(64) },
      gainPercent: 50,
    };
    expect(
      (
        await createManagedPublication(
          publicationRequest("media-1", spec),
          projectId,
          revisionId,
          owner,
          env,
          validateProvenance,
        )
      ).status,
    ).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("returns safe 404s across publication ownership boundaries", async () => {
    const { env, database, create } = environment();
    const created = await createManagedPublication(
      publicationRequest("owner-1"),
      projectId,
      revisionId,
      owner,
      env,
      validateProvenance,
    );
    const publication = z
      .object({ id: z.string() })
      .parse(await created.json());
    const response = await getManagedPublication(
      projectId,
      publication.id,
      "other@example.com",
      fromPartial<D1Database>(database),
    );
    expect(response.status).toBe(404);
    expect(
      (
        await retryManagedPublication(
          projectId,
          publication.id,
          "other@example.com",
          env,
        )
      ).status,
    ).toBe(404);
    expect(create).toHaveBeenCalledOnce();
  });

  it.each([
    {
      inconsistent: {
        playback_status: "ready" as const,
        player_url: null,
        hls_url: null,
      },
      expected: { playback: { status: "processing" } },
    },
    {
      inconsistent: {
        download_status: "ready" as const,
        download_url: null,
      },
      expected: { download: { status: "pending" } },
    },
  ])(
    "maps an inconsistent ready delivery row to its safe fallback",
    async ({ inconsistent, expected }) => {
      const { env, database } = environment();
      const created = await createManagedPublication(
        publicationRequest(crypto.randomUUID()),
        projectId,
        revisionId,
        owner,
        env,
        validateProvenance,
      );
      const publication = z
        .object({ id: z.string() })
        .parse(await created.json());
      Object.assign(database.attempts[0]!, inconsistent);

      const response = await getManagedPublication(
        projectId,
        publication.id,
        owner,
        fromPartial<D1Database>(database),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ attempts: [expected] });
    },
  );

  it("retries failed delivery on the playable Stream master", async () => {
    const { env, database, create } = environment();
    const captionId = "0198c7d4-a5e6-7000-8000-000000000020";
    const captionDigest = "e".repeat(64);
    database.assets.set(captionId, {
      kind: "captions",
      sha256: captionDigest,
    });
    const spec = createNoOpFinishingSpec(360);
    spec.captions = {
      mode: "uploaded",
      language: "en",
      asset: { id: captionId, sha256: captionDigest },
    };
    const created = await createManagedPublication(
      publicationRequest("retry-1", spec),
      projectId,
      revisionId,
      owner,
      env,
      validateProvenance,
    );
    const publication = z
      .object({ id: z.string() })
      .parse(await created.json());
    const first = database.attempts[0]!;
    Object.assign(first, {
      status: "ready",
      stream_video_id: "stream-video-1",
      playback_status: "ready",
      player_url: "https://customer.example/video",
      hls_url: "https://customer.example/video.m3u8",
      caption_status: "failed",
      caption_error: "caption failed",
      download_status: "ready",
      download_url: "https://customer.example/video.mp4",
    } satisfies Partial<AttemptRecord>);

    const retried = await retryManagedPublication(
      projectId,
      publication.id,
      owner,
      env,
    );
    expect(retried.status).toBe(202);
    expect(create).toHaveBeenCalledTimes(2);
    expect(database.attempts[1]).toMatchObject({
      attempt: 2,
      stream_video_id: "stream-video-1",
      playback_status: "ready",
      caption_status: "pending",
      download_status: "ready",
    });
    const body = z
      .object({
        attempts: z.array(
          z.object({
            playback: z.object({ status: z.string() }),
            captions: z.object({ status: z.string() }),
          }),
        ),
      })
      .parse(await retried.json());
    expect(body.attempts[0]).toMatchObject({
      playback: { status: "ready" },
      captions: { status: "failed" },
    });
  });

  it("propagates a retry insert failure when no competing attempt exists", async () => {
    const { env, database, create } = environment();
    const created = await createManagedPublication(
      publicationRequest("retry-insert-failure"),
      projectId,
      revisionId,
      owner,
      env,
      validateProvenance,
    );
    const publication = z
      .object({ id: z.string() })
      .parse(await created.json());
    Object.assign(database.attempts[0]!, {
      status: "failed",
      error_message: "render failed",
      playback_status: "failed",
    } satisfies Partial<AttemptRecord>);
    database.attemptInsertFailure = () => undefined;

    const retried = await retryManagedPublication(
      projectId,
      publication.id,
      owner,
      env,
    );

    expect(retried.status).toBe(502);
    expect(create).toHaveBeenCalledOnce();
  });

  it("accepts a retry insert failure only when a competing attempt exists", async () => {
    const { env, database } = environment();
    const created = await createManagedPublication(
      publicationRequest("retry-insert-race"),
      projectId,
      revisionId,
      owner,
      env,
      validateProvenance,
    );
    const publication = z
      .object({ id: z.string() })
      .parse(await created.json());
    const first = database.attempts[0]!;
    Object.assign(first, {
      status: "failed",
      error_message: "render failed",
      playback_status: "failed",
    } satisfies Partial<AttemptRecord>);
    database.attemptInsertFailure = () => {
      database.attempts.push(
        attemptRecord({
          publication_id: publication.id,
          attempt: 2,
          status: "queued",
        }),
      );
    };

    const retried = await retryManagedPublication(
      projectId,
      publication.id,
      owner,
      env,
    );

    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      attempts: [{ attempt: 1 }, { attempt: 2 }],
    });
  });
});
