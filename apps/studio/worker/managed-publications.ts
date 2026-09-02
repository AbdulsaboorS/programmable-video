import {
  createPublicationRequestSchema,
  finishingSpecSchema,
  managedVideoMaxDurationSeconds,
  managedPublicationHistorySchema,
  managedPublicationSchema,
  videoSpec,
  type FinishingSpec,
  type ManagedPublication,
  type PublicationAttempt,
} from "@programmable-video/contracts";

import type { BoundaryError } from "./worker-utils";

export interface PublicationWorkflowTarget {
  attemptId: string;
  publicationId: string;
  projectId: string;
  revisionId: string;
  ownerEmail: string;
  commitSha: string;
  projectName: string;
  buildAttempt: number;
  manifestDigest: string;
  inputDigest: string;
  previewPrefix: string;
  finishingSpec: FinishingSpec;
  streamVideoId: string | null;
  streamUploadUrl: string | null;
  playbackStatus: string;
  playerUrl: string | null;
  hlsUrl: string | null;
  thumbnailUrl: string | null;
  captionStatus: string;
  downloadStatus: string;
}

interface PublicationRow {
  id: string;
  project_id: string;
  revision_id: string;
  build_attempt: number;
  manifest_digest: string;
  input_digest: string;
  finishing_spec_json: string;
  finishing_spec_digest: string;
  created_at: string;
}

interface AttemptRow {
  id: string;
  publication_id: string;
  attempt: number;
  status: "queued" | "rendering" | "ready" | "failed";
  error_message: string | null;
  stream_video_id: string | null;
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

interface ApprovedBuildRow {
  project_id: string;
  revision_id: string;
  attempt: number;
  manifest_digest: string;
  input_digest: string;
  fps: number;
  duration_in_frames: number;
}

interface AssetRow {
  id: string;
  kind: "audio" | "captions";
  sha256: string;
  validation_status: string;
}

export async function createManagedPublication(
  request: Request,
  projectId: string,
  revisionId: string,
  ownerEmail: string,
  env: Env,
  validateProvenance: () => Promise<Response>,
): Promise<Response> {
  const input = createPublicationRequestSchema.safeParse(
    await request.json().catch(() => undefined),
  );
  if (!input.success) {
    return Response.json(
      { error: "Invalid publication request" },
      { status: 400 },
    );
  }
  const spec = finishingSpecSchema.parse(input.data.finishingSpec);
  const canonicalJson = canonicalFinishingJson(spec);
  const digest = await sha256(canonicalJson);

  try {
    const existing = await findByIdempotencyKey(
      projectId,
      input.data.idempotencyKey,
      ownerEmail,
      env.PROJECTS_DB,
    );
    if (existing) {
      if (
        existing.revision_id !== revisionId ||
        existing.finishing_spec_digest !== digest
      ) {
        return conflict();
      }
      return Response.json(
        await loadPublication(existing.id, ownerEmail, env.PROJECTS_DB),
      );
    }

    const provenance = await validateProvenance();
    if (!provenance.ok) return provenance;
    await provenance.body?.cancel();

    const approved = await env.PROJECTS_DB.prepare(
      `SELECT p.id AS project_id, r.id AS revision_id, b.attempt,
        b.manifest_digest, b.input_digest, b.fps, b.duration_in_frames
       FROM projects p
       JOIN project_revisions r ON r.project_id = p.id
       JOIN revision_builds b ON b.revision_id = r.id AND b.status = 'ready'
       JOIN revision_approvals a ON a.revision_id = r.id
         AND a.build_attempt = b.attempt
         AND a.manifest_digest = b.manifest_digest
         AND a.input_digest = b.input_digest
       WHERE p.id = ? AND p.owner_email = ? AND r.id = ?`,
    )
      .bind(projectId, ownerEmail, revisionId)
      .first<ApprovedBuildRow>();
    if (!approved) return notFound();
    if (
      approved.fps !== videoSpec.fps ||
      ![360, 450].includes(approved.duration_in_frames) ||
      spec.trim.endFrame > approved.duration_in_frames
    ) {
      return Response.json(
        { error: "Finishing settings do not match the approved video" },
        { status: 400 },
      );
    }
    if (!(await validateAssets(spec, projectId, ownerEmail, env.PROJECTS_DB))) {
      return Response.json(
        { error: "Finishing media is unavailable or does not match" },
        { status: 400 },
      );
    }

    const publicationId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const workflowId = crypto.randomUUID();
    const now = new Date().toISOString();
    const captionAsset =
      spec.captions.mode === "uploaded" ? spec.captions.asset : null;
    const statements = [
      env.PROJECTS_DB.prepare(
        `INSERT INTO managed_publications (
          id, project_id, revision_id, owner_email, idempotency_key,
          build_attempt, manifest_digest, input_digest, finishing_spec_version,
          finishing_spec_json, finishing_spec_digest, output_profile,
          output_width, output_height, output_fit, trim_start_frame,
          trim_end_frame, audio_gain_percent, audio_asset_id,
          audio_asset_digest, caption_mode, caption_asset_id,
          caption_asset_digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        publicationId,
        projectId,
        revisionId,
        ownerEmail,
        input.data.idempotencyKey,
        approved.attempt,
        approved.manifest_digest,
        approved.input_digest,
        spec.version,
        canonicalJson,
        digest,
        spec.output.profile,
        spec.output.width,
        spec.output.height,
        spec.output.fit,
        spec.trim.startFrame,
        spec.trim.endFrame,
        spec.audio?.gainPercent ?? null,
        spec.audio?.asset.id ?? null,
        spec.audio?.asset.sha256 ?? null,
        spec.captions.mode,
        captionAsset?.id ?? null,
        captionAsset?.sha256 ?? null,
        now,
      ),
      env.PROJECTS_DB.prepare(
        `INSERT INTO managed_publication_attempts (
          id, publication_id, attempt, workflow_id, status, error_message,
          stream_video_id, stream_upload_url, playback_status, player_url,
          hls_url, caption_status, caption_error, thumbnail_status,
          thumbnail_url, manifest_status, download_status, download_percent,
          download_url, download_error, created_at, updated_at
        ) VALUES (?, ?, 1, ?, 'queued', NULL, NULL, NULL, 'pending', NULL,
          NULL, ?, NULL, 'pending', NULL, 'pending', 'pending', NULL,
          NULL, NULL, ?, ?)`,
      ).bind(
        attemptId,
        publicationId,
        workflowId,
        spec.captions.mode === "none" ? "not_requested" : "pending",
        now,
        now,
      ),
    ];
    try {
      await env.PROJECTS_DB.batch(statements);
    } catch (error) {
      const raced = await findByIdempotencyKey(
        projectId,
        input.data.idempotencyKey,
        ownerEmail,
        env.PROJECTS_DB,
      );
      if (!raced) throw error;
      if (
        raced.revision_id !== revisionId ||
        raced.finishing_spec_digest !== digest
      ) {
        return conflict();
      }
      return Response.json(
        await loadPublication(raced.id, ownerEmail, env.PROJECTS_DB),
      );
    }
    try {
      await env.MANAGED_RENDER_WORKFLOW.create({
        id: workflowId,
        params: { attemptId },
      });
    } catch (error) {
      await failPublicationAttempt(
        attemptId,
        safeError(error),
        env.PROJECTS_DB,
      );
      return Response.json(
        { error: "Could not start publication" },
        { status: 500 },
      );
    }
    return Response.json(
      await loadPublication(publicationId, ownerEmail, env.PROJECTS_DB),
      { status: 202 },
    );
  } catch (error) {
    return platformFailure("Could not create publication", error);
  }
}

export async function listManagedPublications(
  projectId: string,
  ownerEmail: string,
  db: D1Database,
): Promise<Response> {
  try {
    if (!(await ownsProject(projectId, ownerEmail, db))) return notFound();
    const rows = await db
      .prepare(
        `SELECT id, project_id, revision_id, build_attempt, manifest_digest,
          input_digest, finishing_spec_json, finishing_spec_digest, created_at
         FROM managed_publications
         WHERE project_id = ? AND owner_email = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1000`,
      )
      .bind(projectId, ownerEmail)
      .all<PublicationRow>();
    const publications = await Promise.all(
      rows.results.map((row) => loadPublicationFromRow(row, db)),
    );
    return Response.json(
      managedPublicationHistorySchema.parse({ publications }),
    );
  } catch (error) {
    return platformFailure("Could not load publications", error);
  }
}

export async function getManagedPublication(
  projectId: string,
  publicationId: string,
  ownerEmail: string,
  db: D1Database,
): Promise<Response> {
  try {
    const publication = await loadPublication(
      publicationId,
      ownerEmail,
      db,
      projectId,
    );
    return publication ? Response.json(publication) : notFound();
  } catch (error) {
    return platformFailure("Could not load publication", error);
  }
}

export async function retryManagedPublication(
  projectId: string,
  publicationId: string,
  ownerEmail: string,
  env: Env,
): Promise<Response> {
  try {
    const publication = await loadPublication(
      publicationId,
      ownerEmail,
      env.PROJECTS_DB,
      projectId,
    );
    if (!publication) return notFound();
    const latest = publication.attempts.at(-1)!;
    const needsDeliveryRetry =
      latest.captions.status === "failed" ||
      latest.download.status === "failed";
    if (
      latest.status === "queued" ||
      latest.status === "rendering" ||
      (latest.status === "ready" && !needsDeliveryRetry)
    ) {
      return Response.json(publication);
    }
    const attempt = latest.attempt + 1;
    if (attempt > 1_000) {
      return Response.json(
        { error: "Publication retry limit reached" },
        { status: 409 },
      );
    }
    const id = crypto.randomUUID();
    const workflowId = crypto.randomUUID();
    const now = new Date().toISOString();
    const readyPlayback =
      latest.playback.status === "ready" ? latest.playback : null;
    const reusePlayback = readyPlayback !== null;
    const captionStatus =
      latest.captions.status === "ready" ||
      latest.captions.status === "not_requested"
        ? latest.captions.status
        : publication.finishingSpec.captions.mode === "none"
          ? "not_requested"
          : "pending";
    const downloadStatus =
      latest.download.status === "ready" ? "ready" : "pending";
    try {
      await env.PROJECTS_DB.prepare(
        `INSERT INTO managed_publication_attempts (
          id, publication_id, attempt, workflow_id, status, error_message,
          stream_video_id, stream_upload_url, playback_status, player_url,
          hls_url, caption_status, caption_error, thumbnail_status,
          thumbnail_url, manifest_status, download_status, download_percent,
          download_url, download_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'queued', NULL, ?, NULL, ?, ?, ?, ?, NULL,
          ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
        .bind(
          id,
          publicationId,
          attempt,
          workflowId,
          reusePlayback ? latest.streamVideoId : null,
          reusePlayback ? "ready" : "pending",
          readyPlayback?.playerUrl ?? null,
          readyPlayback?.hlsUrl ?? null,
          captionStatus,
          reusePlayback ? "ready" : "pending",
          readyPlayback?.thumbnailUrl ?? null,
          reusePlayback ? "ready" : "pending",
          downloadStatus,
          latest.download.status === "ready" ? null : null,
          latest.download.status === "ready" ? latest.download.url : null,
          now,
          now,
        )
        .run();
    } catch (error) {
      const raced = await loadPublication(
        publicationId,
        ownerEmail,
        env.PROJECTS_DB,
        projectId,
      );
      if (!raced || raced.attempts.at(-1)!.attempt <= latest.attempt)
        throw error;
      return Response.json(raced);
    }
    try {
      await env.MANAGED_RENDER_WORKFLOW.create({
        id: workflowId,
        params: { attemptId: id },
      });
    } catch (error) {
      await failPublicationAttempt(id, safeError(error), env.PROJECTS_DB);
      return Response.json(
        { error: "Could not start publication retry" },
        { status: 500 },
      );
    }
    return Response.json(
      await loadPublication(
        publicationId,
        ownerEmail,
        env.PROJECTS_DB,
        projectId,
      ),
      { status: 202 },
    );
  } catch (error) {
    return platformFailure("Could not retry publication", error);
  }
}

export async function loadPublicationWorkflowTarget(
  attemptId: string,
  db: D1Database,
): Promise<PublicationWorkflowTarget> {
  const row = await db
    .prepare(
      `SELECT a.id AS attempt_id, p.id AS publication_id, p.project_id,
        p.revision_id, p.owner_email, r.commit_sha, project.name AS project_name,
        p.build_attempt, p.manifest_digest, p.input_digest, b.preview_prefix,
        p.finishing_spec_json, a.stream_video_id, a.stream_upload_url,
        a.playback_status, a.player_url, a.hls_url, a.thumbnail_url,
        a.caption_status, a.download_status
       FROM managed_publication_attempts a
       JOIN managed_publications p ON p.id = a.publication_id
       JOIN projects project ON project.id = p.project_id
       JOIN project_revisions r ON r.id = p.revision_id
       JOIN revision_builds b ON b.revision_id = p.revision_id
         AND b.attempt = p.build_attempt AND b.manifest_digest = p.manifest_digest
         AND b.input_digest = p.input_digest AND b.status = 'ready'
       WHERE a.id = ?`,
    )
    .bind(attemptId)
    .first<{
      attempt_id: string;
      publication_id: string;
      project_id: string;
      revision_id: string;
      owner_email: string;
      commit_sha: string;
      project_name: string;
      build_attempt: number;
      manifest_digest: string;
      input_digest: string;
      preview_prefix: string;
      finishing_spec_json: string;
      stream_video_id: string | null;
      stream_upload_url: string | null;
      playback_status: string;
      player_url: string | null;
      hls_url: string | null;
      thumbnail_url: string | null;
      caption_status: string;
      download_status: string;
    }>();
  if (!row) throw new Error("Publication attempt is not available");
  return {
    attemptId: row.attempt_id,
    publicationId: row.publication_id,
    projectId: row.project_id,
    revisionId: row.revision_id,
    ownerEmail: row.owner_email,
    commitSha: row.commit_sha,
    projectName: row.project_name,
    buildAttempt: row.build_attempt,
    manifestDigest: row.manifest_digest,
    inputDigest: row.input_digest,
    previewPrefix: row.preview_prefix,
    finishingSpec: finishingSpecSchema.parse(
      JSON.parse(row.finishing_spec_json),
    ),
    streamVideoId: row.stream_video_id,
    streamUploadUrl: row.stream_upload_url,
    playbackStatus: row.playback_status,
    playerUrl: row.player_url,
    hlsUrl: row.hls_url,
    thumbnailUrl: row.thumbnail_url,
    captionStatus: row.caption_status,
    downloadStatus: row.download_status,
  };
}

export async function markPublicationRendering(
  attemptId: string,
  db: D1Database,
): Promise<void> {
  await update(
    db,
    `UPDATE managed_publication_attempts SET status = 'rendering',
    playback_status = CASE WHEN playback_status = 'ready' THEN 'ready' ELSE 'processing' END,
    error_message = NULL, updated_at = ? WHERE id = ?`,
    [now(), attemptId],
  );
}

export async function persistStreamUpload(
  attemptId: string,
  videoId: string,
  uploadUrl: string,
  db: D1Database,
): Promise<void> {
  await update(
    db,
    `UPDATE managed_publication_attempts SET stream_video_id = ?,
    stream_upload_url = ?, updated_at = ? WHERE id = ? AND stream_video_id IS NULL`,
    [videoId, uploadUrl, now(), attemptId],
  );
}

export async function reservePublicationStreamUpload(
  target: PublicationWorkflowTarget,
  stream: StreamBinding,
  db: D1Database,
): Promise<{ videoId: string; uploadUrl: string }> {
  const persisted = await loadPersistedStreamUpload(target.attemptId, db);
  if (persisted) {
    return {
      videoId: persisted.stream_video_id,
      uploadUrl: persisted.stream_upload_url,
    };
  }
  const directUpload = await stream.createDirectUpload({
    maxDurationSeconds: managedVideoMaxDurationSeconds,
    meta: {
      projectId: target.projectId,
      revisionId: target.revisionId,
      publicationId: target.publicationId,
      attemptId: target.attemptId,
      commitSha: target.commitSha,
      buildAttempt: String(target.buildAttempt),
      manifestDigest: target.manifestDigest,
      name: publicationFileName(target.projectName, target.publicationId),
      source: "programmable-video-managed-publication",
    },
  });
  await persistStreamUpload(
    target.attemptId,
    directUpload.id,
    directUpload.uploadURL,
    db,
  );
  const reserved = await loadPersistedStreamUpload(target.attemptId, db);
  if (!reserved) throw new Error("Could not persist Stream upload reservation");
  return {
    videoId: reserved.stream_video_id,
    uploadUrl: reserved.stream_upload_url,
  };
}

export function publicationFileName(
  projectName: string,
  publicationId: string,
): string {
  const base =
    projectName
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .toLowerCase() || "video";
  return `${base}-${publicationId.slice(0, 8)}.mp4`;
}

export async function recordPlaybackReady(
  attemptId: string,
  video: {
    videoId: string;
    playerUrl: string;
    hlsUrl: string;
    thumbnailUrl: string | null;
  },
  db: D1Database,
): Promise<void> {
  await update(
    db,
    `UPDATE managed_publication_attempts SET stream_video_id = ?,
    playback_status = 'ready', player_url = ?, hls_url = ?, thumbnail_status = ?,
    thumbnail_url = ?, manifest_status = 'ready', error_message = NULL, updated_at = ?
    WHERE id = ?`,
    [
      video.videoId,
      video.playerUrl,
      video.hlsUrl,
      video.thumbnailUrl ? "ready" : "not_requested",
      video.thumbnailUrl,
      now(),
      attemptId,
    ],
  );
}

export async function recordCaptionState(
  attemptId: string,
  status: "pending" | "processing" | "ready" | "failed",
  error: string | null,
  db: D1Database,
): Promise<void> {
  await update(
    db,
    `UPDATE managed_publication_attempts SET caption_status = ?,
    caption_error = ?, updated_at = ? WHERE id = ?`,
    [status, error?.slice(0, 1_000) ?? null, now(), attemptId],
  );
}

export async function recordDownloadState(
  attemptId: string,
  state: {
    status: "pending" | "processing" | "ready" | "failed";
    percent?: number | null;
    url?: string | null;
    error?: string | null;
  },
  db: D1Database,
): Promise<void> {
  await update(
    db,
    `UPDATE managed_publication_attempts SET download_status = ?,
    download_percent = ?, download_url = ?, download_error = ?, updated_at = ?
    WHERE id = ?`,
    [
      state.status,
      state.percent ?? null,
      state.url ?? null,
      state.error?.slice(0, 1_000) ?? null,
      now(),
      attemptId,
    ],
  );
}

export async function completePublicationAttempt(
  attemptId: string,
  db: D1Database,
): Promise<void> {
  await update(
    db,
    `UPDATE managed_publication_attempts SET status = 'ready',
    error_message = NULL, updated_at = ? WHERE id = ? AND playback_status = 'ready'`,
    [now(), attemptId],
  );
}

export async function failPublicationAttempt(
  attemptId: string,
  message: string,
  db: D1Database,
): Promise<void> {
  await update(
    db,
    `UPDATE managed_publication_attempts SET status = 'failed',
    error_message = ?, playback_status = CASE WHEN playback_status = 'ready'
      THEN 'ready' ELSE 'failed' END, updated_at = ? WHERE id = ?`,
    [message.slice(0, 1_000), now(), attemptId],
  );
}

export function canonicalFinishingJson(spec: FinishingSpec): string {
  return JSON.stringify(finishingSpecSchema.parse(spec));
}

async function validateAssets(
  spec: FinishingSpec,
  projectId: string,
  ownerEmail: string,
  db: D1Database,
): Promise<boolean> {
  const references = [
    ...(spec.audio ? [{ ...spec.audio.asset, kind: "audio" as const }] : []),
    ...(spec.captions.mode === "uploaded"
      ? [{ ...spec.captions.asset, kind: "captions" as const }]
      : []),
  ];
  for (const reference of references) {
    const row = await db
      .prepare(
        `SELECT a.id, a.kind, a.sha256, a.validation_status
       FROM project_media_assets a JOIN projects p ON p.id = a.project_id
       WHERE a.id = ? AND a.project_id = ? AND a.owner_email = ?
         AND p.owner_email = ?`,
      )
      .bind(reference.id, projectId, ownerEmail, ownerEmail)
      .first<AssetRow>();
    if (
      !row ||
      row.kind !== reference.kind ||
      row.sha256 !== reference.sha256 ||
      row.validation_status !== "valid"
    )
      return false;
  }
  return true;
}

async function findByIdempotencyKey(
  projectId: string,
  key: string,
  ownerEmail: string,
  db: D1Database,
): Promise<PublicationRow | null> {
  return db
    .prepare(
      `SELECT id, project_id, revision_id, build_attempt,
    manifest_digest, input_digest, finishing_spec_json, finishing_spec_digest,
    created_at FROM managed_publications WHERE project_id = ?
    AND owner_email = ? AND idempotency_key = ?`,
    )
    .bind(projectId, ownerEmail, key)
    .first<PublicationRow>();
}

async function loadPersistedStreamUpload(
  attemptId: string,
  db: D1Database,
): Promise<{ stream_video_id: string; stream_upload_url: string } | null> {
  return db
    .prepare(
      `SELECT stream_video_id, stream_upload_url
       FROM managed_publication_attempts
       WHERE id = ? AND stream_video_id IS NOT NULL AND stream_upload_url IS NOT NULL`,
    )
    .bind(attemptId)
    .first<{ stream_video_id: string; stream_upload_url: string }>();
}

async function loadPublication(
  publicationId: string,
  ownerEmail: string,
  db: D1Database,
  projectId?: string,
): Promise<ManagedPublication | null> {
  const row = await db
    .prepare(
      `SELECT id, project_id, revision_id, build_attempt,
    manifest_digest, input_digest, finishing_spec_json, finishing_spec_digest,
    created_at FROM managed_publications WHERE id = ? AND owner_email = ?
    ${projectId ? "AND project_id = ?" : ""}`,
    )
    .bind(publicationId, ownerEmail, ...(projectId ? [projectId] : []))
    .first<PublicationRow>();
  return row ? loadPublicationFromRow(row, db) : null;
}

async function loadPublicationFromRow(
  row: PublicationRow,
  db: D1Database,
): Promise<ManagedPublication> {
  const attempts = await db
    .prepare(
      `SELECT id, publication_id, attempt, status,
    error_message, stream_video_id, playback_status, player_url, hls_url,
    caption_status, caption_error, thumbnail_url, download_status,
    download_percent, download_url, download_error, created_at, updated_at
    FROM managed_publication_attempts WHERE publication_id = ?
    ORDER BY attempt ASC`,
    )
    .bind(row.id)
    .all<AttemptRow>();
  return managedPublicationSchema.parse({
    id: row.id,
    projectId: row.project_id,
    revisionId: row.revision_id,
    buildAttempt: row.build_attempt,
    manifestDigest: row.manifest_digest,
    inputDigest: row.input_digest,
    finishingSpec: JSON.parse(row.finishing_spec_json),
    finishingSpecDigest: row.finishing_spec_digest,
    attempts: attempts.results.map(mapAttempt),
    createdAt: row.created_at,
  });
}

function mapAttempt(row: AttemptRow): PublicationAttempt {
  const error = row.error_message || "Publication processing failed";
  const playback =
    row.playback_status === "ready" && row.player_url && row.hls_url
      ? {
          status: "ready" as const,
          playerUrl: row.player_url,
          hlsUrl: row.hls_url,
          thumbnailUrl: row.thumbnail_url,
        }
      : row.playback_status === "failed"
        ? { status: "failed" as const, error }
        : row.playback_status === "pending"
          ? { status: "pending" as const }
          : { status: "processing" as const };
  const captions =
    row.caption_status === "ready"
      ? { status: "ready" as const, language: "en" as const }
      : row.caption_status === "failed"
        ? {
            status: "failed" as const,
            error: row.caption_error || "Caption delivery failed",
          }
        : row.caption_status === "not_requested"
          ? { status: "not_requested" as const }
          : row.caption_status === "pending"
            ? { status: "pending" as const }
            : { status: "processing" as const };
  const download =
    row.download_status === "ready" && row.download_url
      ? { status: "ready" as const, url: row.download_url }
      : row.download_status === "failed"
        ? {
            status: "failed" as const,
            error: row.download_error || "Download generation failed",
          }
        : row.download_status === "processing"
          ? {
              status: "processing" as const,
              percentComplete: row.download_percent,
            }
          : row.download_status === "not_requested"
            ? { status: "not_requested" as const }
            : { status: "pending" as const };
  return {
    id: row.id,
    attempt: row.attempt,
    status: row.status,
    error: row.error_message,
    streamVideoId: row.stream_video_id,
    playback,
    captions,
    download,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function ownsProject(
  projectId: string,
  ownerEmail: string,
  db: D1Database,
): Promise<boolean> {
  return Boolean(
    await db
      .prepare("SELECT id FROM projects WHERE id = ? AND owner_email = ?")
      .bind(projectId, ownerEmail)
      .first(),
  );
}

async function update(
  db: D1Database,
  sql: string,
  values: unknown[],
): Promise<void> {
  const result = await db
    .prepare(sql)
    .bind(...values)
    .run();
  if (!result.success) throw new Error("Could not persist publication state");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function now(): string {
  return new Date().toISOString();
}
function safeError(error: BoundaryError): string {
  return error instanceof Error ? error.message : "Publication failed";
}
function conflict(): Response {
  return Response.json(
    {
      error: "Idempotency key was already used for different publication input",
    },
    { status: 409 },
  );
}
function notFound(): Response {
  return Response.json({ error: "Publication not found" }, { status: 404 });
}
function platformFailure(message: string, error: BoundaryError): Response {
  console.error(JSON.stringify({ message, error: safeError(error) }));
  return Response.json({ error: message }, { status: 502 });
}
