import {
  artifactRepoPushedEventSchema,
  projectRevisionListSchema,
  revisionFindingSchema,
  sourceProvenanceSchema,
  type ArtifactRepoPushedEvent,
  type ProjectRevision,
  type RevisionFinding,
  type RevisionBuildStatus,
  type ManagedRenderStatus,
  type RevisionInspectionStatus,
} from "@programmable-video/contracts";
import { z } from "zod";

const inspectionVersion = 1;
const maxFileBytes = 1024 * 1024;
const requestTimeoutMs = 10_000;
const requiredFiles = [
  "index.html",
  "render.html",
  "pnpm-lock.yaml",
  "SOURCE_PROVENANCE.md",
  "tsconfig.json",
  "vite.config.ts",
] as const;
const requiredScripts = ["format:check", "typecheck", "test", "build"] as const;
const packageObjectSchema = z.looseObject({});
const requiredScriptSchema = z.string().trim().min(1);

const artifactRepoPushInputSchema = z.json();
type ArtifactRepoPushInput =
  ArtifactRepoPushedEvent | z.input<typeof artifactRepoPushInputSchema>;

class ArtifactsContentError extends Error {
  constructor(
    message: string,
    readonly kind: "not-found" | "too-large" | "platform",
  ) {
    super(message);
  }
}

export interface RevisionEnv {
  ARTIFACTS_ACCOUNT_ID: string;
  ARTIFACTS_API_TOKEN: string;
  ARTIFACTS_NAMESPACE: string;
  PROJECTS_DB: D1Database;
}

interface RevisionProjectRow {
  id: string;
  repository_name: string;
  repository_default_branch: string;
  repository_remote_url: string;
}

interface RevisionRow {
  id: string;
  project_id: string;
  commit_sha: string;
  ref: string;
  is_default_branch: number;
  inspection_version: number;
  inspection_status: RevisionInspectionStatus;
  inspection_findings: string;
  created_at: string;
  updated_at: string;
  build_status: RevisionBuildStatus | null;
  build_attempt: number | null;
  check_results: string | null;
  manifest_digest: string | null;
  input_digest: string | null;
  build_started_at: string | null;
  build_completed_at: string | null;
  approved_at: string | null;
  approval_manifest_digest: string | null;
  approval_input_digest: string | null;
  approval_build_attempt: number | null;
  render_id: string | null;
  render_status: "queued" | "rendering" | "ready" | "failed" | null;
  stream_video_id: string | null;
  preview_url: string | null;
  hls_url: string | null;
  thumbnail_url: string | null;
  render_error_message: string | null;
}

export interface RevisionTarget {
  id: string;
  projectId: string;
  commitSha: string;
  repositoryName: string;
  repositoryRemoteUrl: string;
  inspectionStatus: RevisionInspectionStatus;
}

export async function loadRevisionTarget(
  revisionId: string,
  db: D1Database,
): Promise<RevisionTarget | null> {
  const row = await db
    .prepare(
      `SELECT r.id, r.project_id, r.commit_sha, r.inspection_status,
          p.repository_name, p.repository_remote_url
       FROM project_revisions r
       JOIN projects p ON p.id = r.project_id
       WHERE r.id = ? AND r.inspection_status = 'valid'`,
    )
    .bind(revisionId)
    .first<{
      id: string;
      project_id: string;
      commit_sha: string;
      inspection_status: RevisionInspectionStatus;
      repository_name: string;
      repository_remote_url: string;
    }>();
  return row
    ? {
        id: row.id,
        projectId: row.project_id,
        commitSha: row.commit_sha,
        repositoryName: row.repository_name,
        repositoryRemoteUrl: row.repository_remote_url,
        inspectionStatus: row.inspection_status,
      }
    : null;
}

interface ArtifactsContentTarget {
  commitSha: string;
  repositoryName: string;
}

interface ProvenanceRevisionRow {
  revision_id: string;
  commit_sha: string;
  repository_name: string;
}

export type RecordRevisionResult =
  | {
      kind: "ignored";
      reason:
        | "namespace-mismatch"
        | "branch-deletion"
        | "unknown-repository"
        | "non-default-ref";
    }
  | { kind: "complete"; target: RevisionTarget }
  | { kind: "pending"; target: RevisionTarget };

export interface InspectionResult {
  status: "valid" | "invalid";
  findings: RevisionFinding[];
}

export async function recordPushedRevision(
  input: ArtifactRepoPushInput,
  env: RevisionEnv,
  workflowTimestamp?: Date,
): Promise<RecordRevisionResult> {
  if (!env.ARTIFACTS_ACCOUNT_ID.trim()) {
    throw new Error("ARTIFACTS_ACCOUNT_ID is required");
  }
  if (!env.ARTIFACTS_NAMESPACE.trim()) {
    throw new Error("ARTIFACTS_NAMESPACE is required");
  }
  const parsed = artifactRepoPushedEventSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "event"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid Artifacts push event: ${issues}`);
  }
  const event = parsed.data;
  if (event.source.namespace !== env.ARTIFACTS_NAMESPACE) {
    return { kind: "ignored", reason: "namespace-mismatch" };
  }
  if (/^0{40}$/.test(event.payload.after)) {
    return { kind: "ignored", reason: "branch-deletion" };
  }

  const project = await env.PROJECTS_DB.prepare(
    `SELECT id, repository_name, repository_default_branch, repository_remote_url
       FROM projects WHERE repository_name = ?`,
  )
    .bind(event.source.repoName)
    .first<RevisionProjectRow>();
  if (!project) return { kind: "ignored", reason: "unknown-repository" };

  const defaultRef = `refs/heads/${project.repository_default_branch}`;
  if (event.payload.ref !== defaultRef) {
    return { kind: "ignored", reason: "non-default-ref" };
  }

  const now =
    "metadata" in event
      ? event.metadata.eventTimestamp
      : workflowTimestamp?.toISOString();
  if (!now) throw new Error("Workflow timestamp is required");
  const revisionId = crypto.randomUUID();
  const inserted = await env.PROJECTS_DB.prepare(
    `INSERT OR IGNORE INTO project_revisions (
       id, project_id, commit_sha, ref, is_default_branch,
       inspection_version, inspection_status, inspection_findings,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, ?, 'pending', '[]', ?, ?)`,
  )
    .bind(
      revisionId,
      project.id,
      event.payload.after.toLowerCase(),
      event.payload.ref,
      inspectionVersion,
      now,
      now,
    )
    .run();
  if (!inserted.success) throw new Error("Could not persist project revision");
  const row = await env.PROJECTS_DB.prepare(
    `SELECT * FROM project_revisions
       WHERE project_id = ? AND commit_sha = ?`,
  )
    .bind(project.id, event.payload.after.toLowerCase())
    .first<RevisionRow>();
  if (!row) throw new Error("Could not persist project revision");
  const target = {
    id: row.id,
    projectId: project.id,
    commitSha: row.commit_sha,
    repositoryName: project.repository_name,
    repositoryRemoteUrl: project.repository_remote_url,
    inspectionStatus: row.inspection_status,
  };
  return row.inspection_status === "pending"
    ? { kind: "pending", target }
    : { kind: "complete", target };
}

export async function inspectRevision(
  target: RevisionTarget,
  env: RevisionEnv,
  fetcher: typeof fetch = fetch,
): Promise<InspectionResult> {
  const findings: RevisionFinding[] = [];
  await readCommit(target, env, fetcher);

  let packageText: string;
  try {
    packageText = await readFile(target, "package.json", env, fetcher);
  } catch (error) {
    if (error instanceof ArtifactsContentError && error.kind === "too-large") {
      return invalid(
        "package.too-large",
        "package.json exceeds the 1 MB inspection limit",
        "package.json",
      );
    }
    if (error instanceof ArtifactsContentError && error.kind === "not-found") {
      return invalid(
        "package.missing",
        "package.json is required",
        "package.json",
      );
    }
    throw error;
  }
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(packageText);
  } catch {
    return invalid(
      "package.invalid-json",
      "package.json is not valid JSON",
      "package.json",
    );
  }

  const parsedPackage = packageObjectSchema.safeParse(packageJson);
  if (!parsedPackage.success) {
    return invalid(
      "package.invalid",
      "package.json must contain an object",
      "package.json",
    );
  }
  const packageManifest = parsedPackage.data;
  if (packageManifest.packageManager !== "pnpm@11.9.0") {
    findings.push({
      severity: "error",
      code: "package.package-manager",
      message: "packageManager must be pinned to pnpm@11.9.0",
      path: "package.json",
    });
  }
  const parsedScripts = packageObjectSchema.safeParse(packageManifest.scripts);
  const scripts = parsedScripts.success ? parsedScripts.data : {};
  for (const script of requiredScripts) {
    if (!requiredScriptSchema.safeParse(scripts[script]).success) {
      findings.push({
        severity: "error",
        code: "package.missing-script",
        message: `Required script ${script} is missing`,
        path: "package.json",
      });
    }
  }

  const fileResults = await Promise.allSettled(
    requiredFiles.map((path) => readFile(target, path, env, fetcher)),
  );
  for (let index = 0; index < fileResults.length; index += 1) {
    const result = fileResults[index];
    if (result?.status === "rejected") {
      if (
        !(result.reason instanceof ArtifactsContentError) ||
        result.reason.kind === "platform"
      ) {
        throw result.reason;
      }
      findings.push({
        severity: "error",
        code:
          result.reason.kind === "too-large"
            ? "structure.file-too-large"
            : "structure.missing-file",
        message: `Required file ${requiredFiles[index]} is missing or unreadable`,
        path: requiredFiles[index],
      });
    }
  }

  return {
    status: findings.some((finding) => finding.severity === "error")
      ? "invalid"
      : "valid",
    findings,
  };
}

export async function finishRevisionInspection(
  revisionId: string,
  result: { status: RevisionInspectionStatus; findings: RevisionFinding[] },
  db: D1Database,
): Promise<boolean> {
  const findings = JSON.stringify(result.findings.slice(0, 100));
  const updated = await db
    .prepare(
      `UPDATE project_revisions
         SET inspection_status = ?, inspection_findings = ?, updated_at = ?
         WHERE id = ? AND inspection_status = 'pending'`,
    )
    .bind(result.status, findings, new Date().toISOString(), revisionId)
    .run();
  if (!updated.success) throw new Error("Could not update revision inspection");
  return updated.meta.changes === 1;
}

export async function listProjectRevisions(
  projectId: string,
  ownerEmail: string,
  db: D1Database,
): Promise<Response> {
  const project = await db
    .prepare("SELECT id FROM projects WHERE id = ? AND owner_email = ?")
    .bind(projectId, ownerEmail)
    .first<{ id: string }>();
  if (!project) {
    return Response.json(
      { error: "Product project not found" },
      { status: 404 },
    );
  }

  const rows = await db
    .prepare(
      `SELECT r.*,
          b.status AS build_status, b.attempt AS build_attempt,
          b.check_results, b.manifest_digest, b.input_digest,
          b.started_at AS build_started_at, b.completed_at AS build_completed_at,
          a.approved_at, a.manifest_digest AS approval_manifest_digest,
          a.input_digest AS approval_input_digest, a.build_attempt AS approval_build_attempt,
          j.id AS render_id, j.status AS render_status, j.stream_video_id,
          j.preview_url, j.hls_url, j.thumbnail_url,
          j.error_message AS render_error_message
       FROM project_revisions r
       LEFT JOIN revision_builds b ON b.revision_id = r.id
       LEFT JOIN revision_approvals a ON a.revision_id = r.id
       LEFT JOIN managed_render_jobs j ON j.id = (
         SELECT id FROM managed_render_jobs
         WHERE revision_id = r.id ORDER BY created_at DESC LIMIT 1
       )
       WHERE r.project_id = ? ORDER BY r.created_at DESC LIMIT 100`,
    )
    .bind(projectId)
    .all<RevisionRow>();
  const revisions = rows.results.map(revisionFromRow);
  const parsed = projectRevisionListSchema.safeParse({ revisions });
  if (!parsed.success) {
    return Response.json(
      { error: "Could not load project revisions" },
      { status: 500 },
    );
  }
  return Response.json(parsed.data);
}

export async function getRevisionSourceProvenance(
  projectId: string,
  revisionId: string,
  ownerEmail: string,
  env: RevisionEnv,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const revision = await env.PROJECTS_DB.prepare(
    `SELECT r.id AS revision_id, r.commit_sha, p.repository_name
       FROM projects p
       JOIN project_revisions r ON r.project_id = p.id
       JOIN revision_builds b ON b.revision_id = r.id
       WHERE p.id = ? AND p.owner_email = ? AND r.id = ? AND b.status = 'ready'`,
  )
    .bind(projectId, ownerEmail, revisionId)
    .first<ProvenanceRevisionRow>();
  if (!revision) return provenanceNotFound();

  let markdown: string;
  try {
    markdown = await readFile(
      {
        commitSha: revision.commit_sha,
        repositoryName: revision.repository_name,
      },
      "SOURCE_PROVENANCE.md",
      env,
      fetcher,
    );
  } catch (error) {
    if (error instanceof ArtifactsContentError) {
      if (error.kind === "not-found") return provenanceNotFound();
      if (error.kind === "too-large") return invalidProvenance();
      return Response.json(
        { error: "Source provenance is temporarily unavailable" },
        { status: 502 },
      );
    }
    throw error;
  }

  const parsed = sourceProvenanceSchema.safeParse({
    revisionId: revision.revision_id,
    commitSha: revision.commit_sha,
    markdown,
  });
  if (!parsed.success) return invalidProvenance();
  return Response.json(parsed.data);
}

function revisionFromRow(row: RevisionRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    commitSha: row.commit_sha,
    ref: row.ref,
    isDefaultBranch: row.is_default_branch === 1,
    inspectionVersion: row.inspection_version,
    status: row.inspection_status,
    findings: inspectionFindingsFromRow(row.inspection_findings),
    build:
      row.build_status && row.build_attempt
        ? {
            status: row.build_status,
            attempt: row.build_attempt,
            checks: JSON.parse(row.check_results ?? "[]"),
            manifestDigest: row.manifest_digest,
            inputDigest: row.input_digest,
            startedAt: row.build_started_at,
            completedAt: row.build_completed_at,
          }
        : null,
    approval:
      row.approved_at &&
      row.approval_manifest_digest &&
      row.approval_input_digest &&
      row.approval_build_attempt
        ? {
            approvedAt: row.approved_at,
            manifestDigest: row.approval_manifest_digest,
            inputDigest: row.approval_input_digest,
            attempt: row.approval_build_attempt,
          }
        : null,
    latestRender: renderFromRow(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function inspectionFindingsFromRow(
  value: string,
): ProjectRevision["findings"] | null {
  try {
    const parsed = z
      .array(revisionFindingSchema)
      .max(100)
      .safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function renderFromRow(row: RevisionRow): ManagedRenderStatus | null {
  if (!row.render_id || !row.render_status) return null;
  if (row.render_status === "ready") {
    if (
      !row.stream_video_id ||
      !row.preview_url ||
      !row.hls_url ||
      !row.thumbnail_url
    ) {
      return null;
    }
    return {
      id: row.render_id,
      status: "ready",
      videoId: row.stream_video_id,
      previewUrl: row.preview_url,
      hlsUrl: row.hls_url,
      thumbnailUrl: row.thumbnail_url,
    };
  }
  if (row.render_status === "failed") {
    return {
      id: row.render_id,
      status: "failed",
      error: row.render_error_message ?? "Render failed",
    };
  }
  return { id: row.render_id, status: row.render_status };
}

async function readCommit(
  target: ArtifactsContentTarget,
  env: RevisionEnv,
  fetcher: typeof fetch,
): Promise<void> {
  const response = await artifactsRequest(
    target,
    `commit/${target.commitSha}`,
    env,
    fetcher,
  );
  await response.body?.cancel();
}

async function readFile(
  target: ArtifactsContentTarget,
  path: string,
  env: RevisionEnv,
  fetcher: typeof fetch,
): Promise<string> {
  const query = new URLSearchParams({ ref: target.commitSha, path });
  const response = await artifactsRequest(
    target,
    `file?${query.toString()}`,
    env,
    fetcher,
  );
  return readBoundedText(response);
}

async function artifactsRequest(
  target: ArtifactsContentTarget,
  suffix: string,
  env: RevisionEnv,
  fetcher: typeof fetch,
): Promise<Response> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.ARTIFACTS_ACCOUNT_ID)}/artifacts/namespaces/${encodeURIComponent(env.ARTIFACTS_NAMESPACE)}/repos/${encodeURIComponent(target.repositoryName)}`;
  const response = await fetcher(`${base}/${suffix}`, {
    headers: { authorization: `Bearer ${env.ARTIFACTS_API_TOKEN}` },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ArtifactsContentError(
      `Artifacts content request returned HTTP ${response.status}`,
      response.status === 404 ? "not-found" : "platform",
    );
  }
  return response;
}

function provenanceNotFound(): Response {
  return Response.json(
    { error: "Source provenance not found" },
    { status: 404 },
  );
}

function invalidProvenance(): Response {
  return Response.json(
    {
      error:
        "Source provenance is invalid or incomplete. Request changes so the agent completes every required section.",
    },
    { status: 422 },
  );
}

async function readBoundedText(response: Response): Promise<string> {
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxFileBytes) {
    await response.body?.cancel();
    throw new ArtifactsContentError("Artifacts file exceeds 1 MB", "too-large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxFileBytes) {
      await reader.cancel();
      throw new ArtifactsContentError(
        "Artifacts file exceeds 1 MB",
        "too-large",
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function invalid(
  code: string,
  message: string,
  path: string,
): InspectionResult {
  return {
    status: "invalid",
    findings: [{ severity: "error", code, message, path }],
  };
}

export function revisionErrorFinding(): RevisionFinding {
  return {
    severity: "error",
    code: "inspection.platform-error",
    message: "The revision could not be inspected",
  };
}

export type { ArtifactRepoPushedEvent };
