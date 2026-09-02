import type {
  ManagedVideoSpec,
  RevisionCheckResult,
} from "@programmable-video/contracts";

const maxConcurrentBuilds = 2;
const staleBuildMs = 40 * 60 * 1_000;

export interface RevisionBuildRetryCommand {
  kind: "retry-build";
  projectId: string;
  revisionId: string;
  attempt: number;
}

export interface RevisionBuildAttempt {
  attempt: number;
}

export type RevisionBuildClaim =
  | { kind: "claimed"; attempt: number; createdAt: string }
  | { kind: "waiting" }
  | { kind: "unavailable" };

export interface StaleRevisionBuild {
  revisionId: string;
  attempt: number;
  leaseOwner: string | null;
}

export async function queueInitialRevisionBuild(
  revisionId: string,
  db: D1Database,
  now = new Date(),
): Promise<RevisionBuildAttempt | null> {
  const timestamp = now.toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO revision_builds (
       revision_id, status, attempt, check_results, created_at, updated_at
     ) VALUES (?, 'queued', 1, '[]', ?, ?)`,
    )
    .bind(revisionId, timestamp, timestamp)
    .run();
  return db
    .prepare(
      `SELECT attempt FROM revision_builds
       WHERE revision_id = ? AND status = 'queued'`,
    )
    .bind(revisionId)
    .first<RevisionBuildAttempt>();
}

export async function claimRevisionBuild(
  revisionId: string,
  attempt: number,
  leaseOwner: string,
  db: D1Database,
  now = new Date(),
): Promise<RevisionBuildClaim> {
  const timestamp = now.toISOString();
  const claimed = await db
    .prepare(
      `UPDATE revision_builds
       SET status = 'running', started_at = ?, completed_at = NULL,
           error_message = NULL, lease_owner = ?, updated_at = ?
       WHERE revision_id = ? AND attempt = ? AND status = 'queued'
         AND (SELECT COUNT(*) FROM revision_builds WHERE status = 'running') < ?
       RETURNING attempt, created_at AS createdAt`,
    )
    .bind(
      timestamp,
      leaseOwner,
      timestamp,
      revisionId,
      attempt,
      maxConcurrentBuilds,
    )
    .first<RevisionBuildAttempt & { createdAt: string }>();
  if (claimed) {
    return {
      kind: "claimed",
      attempt: claimed.attempt,
      createdAt: claimed.createdAt,
    };
  }

  const current = await db
    .prepare(
      `SELECT status, attempt, lease_owner, created_at
       FROM revision_builds WHERE revision_id = ?`,
    )
    .bind(revisionId)
    .first<{
      status: string;
      attempt: number;
      lease_owner: string | null;
      created_at: string;
    }>();
  if (
    current?.status === "running" &&
    current.attempt === attempt &&
    current.lease_owner === leaseOwner
  ) {
    return { kind: "claimed", attempt, createdAt: current.created_at };
  }
  return current?.status === "queued" && current.attempt === attempt
    ? { kind: "waiting" }
    : { kind: "unavailable" };
}

export async function listStaleRevisionBuilds(
  db: D1Database,
  now = new Date(),
): Promise<StaleRevisionBuild[]> {
  const staleBefore = new Date(now.getTime() - staleBuildMs).toISOString();
  const rows = await db
    .prepare(
      `SELECT revision_id, attempt, lease_owner
       FROM revision_builds
       WHERE status = 'running' AND started_at < ?
       LIMIT ?`,
    )
    .bind(staleBefore, maxConcurrentBuilds)
    .all<{
      revision_id: string;
      attempt: number;
      lease_owner: string | null;
    }>();
  return rows.results.map((row) => ({
    revisionId: row.revision_id,
    attempt: row.attempt,
    leaseOwner: row.lease_owner,
  }));
}

export async function expireStaleRevisionBuild(
  build: StaleRevisionBuild,
  db: D1Database,
  now = new Date(),
): Promise<boolean> {
  const timestamp = now.toISOString();
  const staleBefore = new Date(now.getTime() - staleBuildMs).toISOString();
  const updated = await db
    .prepare(
      `UPDATE revision_builds
       SET status = 'error', error_message = 'The build worker stopped before completing',
           completed_at = ?, updated_at = ?
       WHERE revision_id = ? AND attempt = ? AND status = 'running'
         AND (lease_owner = ? OR (lease_owner IS NULL AND ? IS NULL))
         AND started_at < ?`,
    )
    .bind(
      timestamp,
      timestamp,
      build.revisionId,
      build.attempt,
      build.leaseOwner,
      build.leaseOwner,
      staleBefore,
    )
    .run();
  return updated.meta.changes === 1;
}

export async function failQueuedRevisionBuild(
  revisionId: string,
  attempt: number,
  message: string,
  db: D1Database,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE revision_builds
       SET status = 'error', error_message = ?, completed_at = ?, updated_at = ?
       WHERE revision_id = ? AND attempt = ? AND status = 'queued'`,
    )
    .bind(message.slice(0, 1_000), now, now, revisionId, attempt)
    .run();
}

export async function queueRevisionBuildRetry(
  projectId: string,
  revisionId: string,
  ownerEmail: string,
  db: D1Database,
): Promise<
  | { kind: "queued"; attempt: number }
  | { kind: "already-queued"; attempt: number }
  | { kind: "not-retryable" }
  | { kind: "not-found" }
> {
  const owned = await db
    .prepare(
      `SELECT b.status, b.attempt
       FROM projects p
       JOIN project_revisions r ON r.project_id = p.id
       JOIN revision_builds b ON b.revision_id = r.id
       WHERE p.id = ? AND p.owner_email = ? AND r.id = ?
         AND r.inspection_status = 'valid'`,
    )
    .bind(projectId, ownerEmail, revisionId)
    .first<{ status: string; attempt: number }>();
  if (!owned) return { kind: "not-found" };
  if (owned.status === "queued" && owned.attempt > 1) {
    return { kind: "already-queued", attempt: owned.attempt };
  }
  if (owned.status !== "error" || owned.attempt >= 1_000) {
    return { kind: "not-retryable" };
  }

  const now = new Date().toISOString();
  const queued = await db
    .prepare(
      `UPDATE revision_builds
       SET status = 'queued', attempt = attempt + 1, check_results = '[]',
           preview_prefix = NULL, manifest_digest = NULL, input_digest = NULL,
           fps = NULL, duration_in_frames = NULL, error_message = NULL,
           lease_owner = NULL, started_at = NULL, completed_at = NULL,
           updated_at = ?
       WHERE revision_id = ? AND status = 'error' AND attempt = ?
       RETURNING attempt`,
    )
    .bind(now, revisionId, owned.attempt)
    .first<RevisionBuildAttempt>();
  return queued
    ? { kind: "queued", attempt: queued.attempt }
    : { kind: "not-retryable" };
}

export function revisionSandboxId(revisionId: string, attempt: number): string {
  return `revision-${revisionId}-attempt-${attempt}`;
}

export async function isRevisionBuildActive(
  revisionId: string,
  attempt: number,
  leaseOwner: string,
  db: D1Database,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS active FROM revision_builds
       WHERE revision_id = ? AND attempt = ? AND status = 'running'
         AND lease_owner = ?`,
    )
    .bind(revisionId, attempt, leaseOwner)
    .first<{ active: number }>();
  return row?.active === 1;
}

export async function completeRevisionBuild(
  revisionId: string,
  attempt: number,
  leaseOwner: string,
  status: "invalid" | "error" | "ready",
  results: RevisionCheckResult[],
  details: {
    previewPrefix?: string;
    manifestDigest?: string;
    inputDigest?: string;
    videoSpec?: ManagedVideoSpec;
    errorMessage?: string;
  },
  db: D1Database,
): Promise<boolean> {
  const now = new Date().toISOString();
  const updated = await db
    .prepare(
      `UPDATE revision_builds SET status = ?, check_results = ?, preview_prefix = ?,
       manifest_digest = ?, input_digest = ?, fps = ?, duration_in_frames = ?,
       error_message = ?, completed_at = ?, updated_at = ?
     WHERE revision_id = ? AND attempt = ? AND status = 'running'
       AND lease_owner = ?`,
    )
    .bind(
      status,
      JSON.stringify(results),
      details.previewPrefix ?? null,
      details.manifestDigest ?? null,
      details.inputDigest ?? null,
      details.videoSpec?.fps ?? null,
      details.videoSpec?.durationInFrames ?? null,
      details.errorMessage?.slice(0, 1_000) ?? null,
      now,
      now,
      revisionId,
      attempt,
      leaseOwner,
    )
    .run();
  return updated.meta.changes === 1;
}

export async function requestRevisionBuildRetry(
  request: Request,
  projectId: string,
  revisionId: string,
  ownerEmail: string,
  env: {
    PROJECTS_DB: D1Database;
    REVISION_WORKFLOW: {
      createBatch(
        options: Array<{ id: string; params: RevisionBuildRetryCommand }>,
      ): Promise<WorkflowInstance[] | void>;
      get(id: string): Promise<{
        status(): Promise<{ status: string }>;
        restart(): Promise<void>;
      }>;
    };
  },
): Promise<Response> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json(
      { error: "Content-Type must be application/json" },
      { status: 415 },
    );
  }
  const queued = await queueRevisionBuildRetry(
    projectId,
    revisionId,
    ownerEmail,
    env.PROJECTS_DB,
  );
  if (queued.kind === "not-found") {
    return Response.json(
      { error: "Product revision not found" },
      { status: 404 },
    );
  }
  if (queued.kind === "not-retryable") {
    return Response.json(
      { error: "This preview build cannot be retried" },
      { status: 409 },
    );
  }
  const workflowId = `revision-${revisionId}-attempt-${queued.attempt}`;
  try {
    const created = await env.REVISION_WORKFLOW.createBatch([
      {
        id: workflowId,
        params: {
          kind: "retry-build",
          projectId,
          revisionId,
          attempt: queued.attempt,
        },
      },
    ]);
    if (Array.isArray(created) && created.length === 0) {
      const existing = await env.REVISION_WORKFLOW.get(workflowId);
      const status = await existing.status();
      if (["complete", "errored", "terminated"].includes(status.status)) {
        await existing.restart();
      }
    }
  } catch {
    return Response.json(
      { error: "Could not start the preview build retry" },
      { status: 503 },
    );
  }
  return Response.json(
    { status: "queued", attempt: queued.attempt },
    { status: 202 },
  );
}
