import {
  previewSessionSchema,
  revisionApprovalSummarySchema,
} from "@programmable-video/contracts";

import { signPreviewCapability } from "./preview-capability";

const previewTtlSeconds = 5 * 60;

interface ReadyRevisionRow {
  project_id: string;
  revision_id: string;
  commit_sha: string;
  attempt: number;
  preview_prefix: string;
  manifest_digest: string;
  input_digest: string;
}

interface DeliveryEnv {
  PREVIEW_ORIGIN: string;
  PREVIEW_SIGNING_KEY: string;
  PROJECTS_DB: D1Database;
}

export async function createPreviewSession(
  projectId: string,
  revisionId: string,
  ownerEmail: string,
  env: DeliveryEnv,
  studioOrigin: string,
): Promise<Response> {
  let origin: URL;
  try {
    origin = new URL(env.PREVIEW_ORIGIN);
  } catch {
    return previewConfigurationError();
  }
  if (origin.protocol !== "https:" || origin.origin === studioOrigin) {
    return previewConfigurationError();
  }
  const revision = await readyRevision(
    projectId,
    revisionId,
    ownerEmail,
    env.PROJECTS_DB,
  );
  if (!revision) return notFound();

  const expiresAt = Math.floor(Date.now() / 1_000) + previewTtlSeconds;
  const token = await signPreviewCapability(
    {
      version: 1,
      projectId: revision.project_id,
      revisionId: revision.revision_id,
      commitSha: revision.commit_sha,
      attempt: revision.attempt,
      prefix: revision.preview_prefix,
      manifestDigest: revision.manifest_digest,
      owner: ownerEmail,
      expiresAt,
    },
    env.PREVIEW_SIGNING_KEY,
  );
  origin.pathname = "/launch";
  origin.searchParams.set("token", token);
  return Response.json(
    previewSessionSchema.parse({
      url: origin.toString(),
      expiresAt: new Date(expiresAt * 1_000).toISOString(),
    }),
    { status: 201 },
  );
}

function previewConfigurationError(): Response {
  return Response.json(
    { error: "Preview service is not configured safely" },
    { status: 500 },
  );
}

export async function approveRevision(
  projectId: string,
  revisionId: string,
  ownerEmail: string,
  db: D1Database,
): Promise<Response> {
  const revision = await readyRevision(projectId, revisionId, ownerEmail, db);
  if (!revision) return notFound();
  const approvedAt = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO revision_approvals (
       revision_id, build_attempt, manifest_digest, input_digest, approved_by, approved_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      revision.revision_id,
      revision.attempt,
      revision.manifest_digest,
      revision.input_digest,
      ownerEmail,
      approvedAt,
    )
    .run();
  if (!result.success) {
    return Response.json(
      { error: "Could not approve revision" },
      { status: 500 },
    );
  }
  const approval = await db
    .prepare(
      `SELECT build_attempt, manifest_digest, input_digest, approved_at
     FROM revision_approvals WHERE revision_id = ?`,
    )
    .bind(revisionId)
    .first<{
      build_attempt: number;
      manifest_digest: string;
      input_digest: string;
      approved_at: string;
    }>();
  if (!approval)
    return Response.json(
      { error: "Could not approve revision" },
      { status: 500 },
    );
  return Response.json(
    revisionApprovalSummarySchema.parse({
      attempt: approval.build_attempt,
      manifestDigest: approval.manifest_digest,
      inputDigest: approval.input_digest,
      approvedAt: approval.approved_at,
    }),
    { status: result.meta.changes === 1 ? 201 : 200 },
  );
}

async function readyRevision(
  projectId: string,
  revisionId: string,
  ownerEmail: string,
  db: D1Database,
): Promise<ReadyRevisionRow | null> {
  return db
    .prepare(
      `SELECT p.id AS project_id, r.id AS revision_id, r.commit_sha,
       b.attempt, b.preview_prefix, b.manifest_digest, b.input_digest
     FROM projects p
     JOIN project_revisions r ON r.project_id = p.id
     JOIN revision_builds b ON b.revision_id = r.id
     WHERE p.id = ? AND p.owner_email = ? AND r.id = ? AND b.status = 'ready'`,
    )
    .bind(projectId, ownerEmail, revisionId)
    .first<ReadyRevisionRow>();
}

function notFound(): Response {
  return Response.json(
    { error: "Product revision not found" },
    { status: 404 },
  );
}
