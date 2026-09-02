import { managedRenderStatusSchema } from "@programmable-video/contracts";

import type { BoundaryError } from "./worker-utils";

export interface ManagedRenderJobRow {
  id: string;
  project_id: string;
  revision_id: string;
  owner_email: string;
  commit_sha: string;
  build_attempt: number;
  manifest_digest: string;
  input_digest: string;
  preview_prefix: string;
}

export async function createManagedRender(
  projectId: string,
  revisionId: string,
  ownerEmail: string,
  env: Env,
): Promise<Response> {
  const approved = await env.PROJECTS_DB.prepare(
    `SELECT p.id AS project_id, r.id AS revision_id, r.commit_sha,
       b.attempt, b.manifest_digest, b.input_digest
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
    .first<{
      project_id: string;
      revision_id: string;
      commit_sha: string;
      attempt: number;
      manifest_digest: string;
      input_digest: string;
    }>();
  if (!approved) {
    return Response.json(
      { error: "Approved revision not found" },
      { status: 404 },
    );
  }

  const id = crypto.randomUUID();
  const workflowId = crypto.randomUUID();
  const now = new Date().toISOString();
  const inserted = await env.PROJECTS_DB.prepare(
    `INSERT INTO managed_render_jobs (
       id, project_id, revision_id, owner_email, build_attempt,
       manifest_digest, input_digest, workflow_id, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
  )
    .bind(
      id,
      approved.project_id,
      approved.revision_id,
      ownerEmail,
      approved.attempt,
      approved.manifest_digest,
      approved.input_digest,
      workflowId,
      now,
      now,
    )
    .run();
  if (!inserted.success) {
    return Response.json({ error: "Could not create render" }, { status: 500 });
  }
  try {
    await env.MANAGED_RENDER_WORKFLOW.create({
      id: workflowId,
      params: { jobId: id },
    });
  } catch (error) {
    await failManagedRender(id, safeError(error), env.PROJECTS_DB);
    return Response.json({ error: "Could not start render" }, { status: 500 });
  }
  return Response.json(
    managedRenderStatusSchema.parse({ id, status: "queued" }),
    {
      status: 202,
    },
  );
}

export async function loadManagedRenderJob(
  jobId: string,
  db: D1Database,
): Promise<ManagedRenderJobRow> {
  const row = await db
    .prepare(
      `SELECT j.id, j.project_id, j.revision_id, j.owner_email,
       r.commit_sha, j.build_attempt, j.manifest_digest, j.input_digest,
       b.preview_prefix
     FROM managed_render_jobs j
     JOIN project_revisions r ON r.id = j.revision_id
     JOIN revision_builds b ON b.revision_id = j.revision_id
     WHERE j.id = ? AND j.status IN ('queued', 'rendering')
       AND b.status = 'ready' AND b.attempt = j.build_attempt
       AND b.manifest_digest = j.manifest_digest AND b.input_digest = j.input_digest`,
    )
    .bind(jobId)
    .first<ManagedRenderJobRow>();
  if (!row) throw new Error("Managed render job is not available");
  return row;
}

export async function markManagedRenderRendering(
  jobId: string,
  db: D1Database,
) {
  await db
    .prepare(
      `UPDATE managed_render_jobs SET status = 'rendering', updated_at = ?
     WHERE id = ? AND status = 'queued'`,
    )
    .bind(new Date().toISOString(), jobId)
    .run();
}

export async function finishManagedRender(
  jobId: string,
  video: {
    videoId: string;
    previewUrl: string;
    hlsUrl: string;
    thumbnailUrl: string;
  },
  db: D1Database,
) {
  await db
    .prepare(
      `UPDATE managed_render_jobs SET status = 'ready', stream_video_id = ?,
       preview_url = ?, hls_url = ?, thumbnail_url = ?, updated_at = ?
     WHERE id = ?`,
    )
    .bind(
      video.videoId,
      video.previewUrl,
      video.hlsUrl,
      video.thumbnailUrl,
      new Date().toISOString(),
      jobId,
    )
    .run();
}

export async function failManagedRender(
  jobId: string,
  message: string,
  db: D1Database,
) {
  await db
    .prepare(
      `UPDATE managed_render_jobs SET status = 'failed', error_message = ?, updated_at = ?
     WHERE id = ?`,
    )
    .bind(message.slice(0, 1_000), new Date().toISOString(), jobId)
    .run();
}

function safeError(error: BoundaryError): string {
  return error instanceof Error ? error.message : "Managed render failed";
}
