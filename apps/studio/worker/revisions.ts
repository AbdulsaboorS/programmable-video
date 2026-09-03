import {
  artifactRepoPushedEventSchema,
  projectRevisionListSchema,
  revisionBundleMaxBytes,
  revisionBundleSubmissionResultSchema,
  revisionBundleSubmissionSchema,
  revisionFindingSchema,
  sourceProvenanceSchema,
  type ArtifactRepoPushedEvent,
  type ProjectRevision,
  type RevisionFinding,
  type RevisionBuildStatus,
  type ManagedRenderStatus,
  type RevisionInspectionStatus,
  type RevisionSubmissionWorkflowCommand,
} from "@programmable-video/contracts";
import { createHash } from "node:crypto";
import { z } from "zod";

import { platformFailure, type BoundaryError } from "./worker-utils";

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

export class RevisionContentError extends Error {
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

export interface RevisionSubmissionEnv extends RevisionEnv {
  REVISION_SOURCES: R2Bucket;
  REVISION_WORKFLOW: Workflow<RevisionSubmissionWorkflowCommand>;
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
  ref: string;
  inspectionStatus: RevisionInspectionStatus;
  source:
    | {
        kind: "artifacts";
        repositoryName: string;
        repositoryRemoteUrl: string;
      }
    | {
        kind: "r2-bundle";
        bundleKey: string;
        bundleDigest: string;
        bundleSize: number;
      };
}

export async function loadRevisionTarget(
  revisionId: string,
  db: D1Database,
): Promise<RevisionTarget | null> {
  const row = await db
    .prepare(
      `SELECT r.id, r.project_id, r.commit_sha, r.ref, r.inspection_status,
          r.source_kind, r.source_bundle_key, r.source_bundle_digest,
          r.source_bundle_size, p.repository_name, p.repository_remote_url
       FROM project_revisions r
       JOIN projects p ON p.id = r.project_id
       WHERE r.id = ? AND r.inspection_status = 'valid'`,
    )
    .bind(revisionId)
    .first<RevisionTargetRow>();
  return row ? targetFromRow(row) : null;
}

export async function loadPendingRevisionTarget(
  revisionId: string,
  projectId: string,
  db: D1Database,
): Promise<RevisionTarget | null> {
  const row = await db
    .prepare(
      `SELECT r.id, r.project_id, r.commit_sha, r.ref, r.inspection_status,
          r.source_kind, r.source_bundle_key, r.source_bundle_digest,
          r.source_bundle_size, p.repository_name, p.repository_remote_url
       FROM project_revisions r
       JOIN projects p ON p.id = r.project_id
       WHERE r.id = ? AND r.project_id = ? AND r.source_kind = 'r2-bundle'`,
    )
    .bind(revisionId, projectId)
    .first<RevisionTargetRow>();
  return row ? targetFromRow(row) : null;
}

interface RevisionTargetRow {
  id: string;
  project_id: string;
  commit_sha: string;
  ref: string;
  inspection_status: RevisionInspectionStatus;
  source_kind: "artifacts" | "r2-bundle";
  source_bundle_key: string | null;
  source_bundle_digest: string | null;
  source_bundle_size: number | null;
  repository_name: string;
  repository_remote_url: string;
}

function targetFromRow(row: RevisionTargetRow): RevisionTarget {
  const base = {
    id: row.id,
    projectId: row.project_id,
    commitSha: row.commit_sha,
    ref: row.ref,
    inspectionStatus: row.inspection_status,
  };
  if (row.source_kind === "artifacts") {
    return {
      ...base,
      source: {
        kind: "artifacts",
        repositoryName: row.repository_name,
        repositoryRemoteUrl: row.repository_remote_url,
      },
    };
  }
  if (
    !row.source_bundle_key ||
    !row.source_bundle_digest ||
    !row.source_bundle_size
  ) {
    throw new Error("Bundle revision source identity is incomplete");
  }
  return {
    ...base,
    source: {
      kind: "r2-bundle",
      bundleKey: row.source_bundle_key,
      bundleDigest: row.source_bundle_digest,
      bundleSize: row.source_bundle_size,
    },
  };
}

interface ArtifactsContentTarget {
  commitSha: string;
  repositoryName: string;
}

interface ProvenanceRevisionRow {
  revision_id: string;
  commit_sha: string;
  repository_name: string;
  source_kind: "artifacts" | "r2-bundle";
  source_provenance: string | null;
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

export async function submitRevisionBundle(
  request: Request,
  projectId: string,
  ownerEmail: string,
  env: RevisionSubmissionEnv,
): Promise<Response> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
    "application/x-git-bundle"
  ) {
    return Response.json(
      { error: "Expected application/x-git-bundle" },
      { status: 415 },
    );
  }
  const submission = revisionBundleSubmissionSchema.safeParse({
    commitSha: request.headers.get("x-video-commit-sha"),
    ref: request.headers.get("x-video-ref"),
    bundleSha256: request.headers.get("x-video-bundle-sha256"),
    bundleSize: Number(request.headers.get("content-length")),
  });
  if (!submission.success || !request.body) {
    return Response.json(
      { error: "Invalid revision bundle submission" },
      { status: 400 },
    );
  }
  const input = {
    ...submission.data,
    commitSha: submission.data.commitSha.toLowerCase(),
    bundleSha256: submission.data.bundleSha256.toLowerCase(),
  };

  let project: {
    id: string;
    authoring_source_kind: "artifacts" | "local";
    repository_default_branch: string;
  } | null;
  try {
    project = await env.PROJECTS_DB.prepare(
      "SELECT id, authoring_source_kind, repository_default_branch FROM projects WHERE id = ? AND owner_email = ?",
    )
      .bind(projectId, ownerEmail)
      .first();
  } catch (error) {
    return platformFailure("Could not load the product project", error);
  }
  if (!project)
    return Response.json(
      { error: "Product project not found" },
      { status: 404 },
    );
  if (project.authoring_source_kind !== "local") {
    return Response.json(
      { error: "Project does not accept local revisions" },
      { status: 409 },
    );
  }
  if (input.ref !== `refs/heads/${project.repository_default_branch}`) {
    await request.body.cancel();
    return Response.json(
      {
        error: `Revision must be submitted from ${project.repository_default_branch}`,
      },
      { status: 409 },
    );
  }

  let existing: SubmittedRevisionRow | null;
  try {
    existing = await findSubmittedRevision(
      projectId,
      input.commitSha,
      env.PROJECTS_DB,
    );
  } catch (error) {
    return platformFailure("Could not check the project revision", error);
  }
  const objectKey = revisionBundleKey(
    projectId,
    input.commitSha,
    input.bundleSha256,
  );
  if (
    existing &&
    (!sameBundleIdentity(existing, input) ||
      existing.source_bundle_key !== objectKey)
  ) {
    await request.body.cancel();
    return Response.json(
      { error: "Commit already has a different revision source" },
      { status: 409 },
    );
  }

  if (existing) {
    const stored = await env.REVISION_SOURCES.head(objectKey).catch(() => null);
    if (validBundleObject(stored, projectId, input)) {
      try {
        await consumeVerifiedBundle(
          request.body,
          input.bundleSize,
          input.bundleSha256,
        );
      } catch (error) {
        return bundleReadFailure(error);
      }
      const dispatch = await dispatchSubmittedRevision(
        existing.id,
        projectId,
        env,
      );
      if (dispatch) return dispatch;
      return submissionResponse(
        existing.id,
        input.commitSha,
        "already-submitted",
        200,
      );
    }
    await env.REVISION_SOURCES.delete(objectKey).catch(() => undefined);
  }

  let storedByRequest = false;
  const temporaryKey = `${objectKey}.upload-${crypto.randomUUID()}`;
  try {
    const fixed = new FixedLengthStream(input.bundleSize);
    const objectOptions = {
      httpMetadata: {
        contentType: "application/x-git-bundle",
        cacheControl: "private, no-store",
      },
      customMetadata: {
        projectId,
        commitSha: input.commitSha,
        ref: input.ref,
        sha256: input.bundleSha256,
        byteSize: String(input.bundleSize),
      },
      sha256: digestBytes(input.bundleSha256),
    } satisfies R2PutOptions;
    const upload = env.REVISION_SOURCES.put(
      temporaryKey,
      fixed.readable,
      objectOptions,
    );
    const verification = pipeVerifiedBundle(
      request.body,
      fixed.writable,
      input.bundleSize,
      input.bundleSha256,
    );
    const [uploadResult, verificationResult] = await Promise.allSettled([
      upload,
      verification,
    ]);
    if (verificationResult.status === "rejected") {
      if (uploadResult.status === "fulfilled" && uploadResult.value) {
        await env.REVISION_SOURCES.delete(temporaryKey);
      }
      throw verificationResult.reason;
    }
    if (uploadResult.status === "rejected") throw uploadResult.reason;
    const temporary = await env.REVISION_SOURCES.get(temporaryKey);
    if (!temporary || !validBundleObject(temporary, projectId, input)) {
      throw new Error("Stored revision bundle identity does not match");
    }
    const stored = await env.REVISION_SOURCES.put(objectKey, temporary.body, {
      ...objectOptions,
      onlyIf: { etagDoesNotMatch: "*" },
    });
    storedByRequest = stored !== null;
    if (!stored) {
      const object = await env.REVISION_SOURCES.head(objectKey);
      if (!validBundleObject(object, projectId, input)) {
        return Response.json(
          { error: "Revision bundle source conflicts" },
          { status: 409 },
        );
      }
    }
  } catch (error) {
    return bundleReadFailure(error);
  } finally {
    await env.REVISION_SOURCES.delete(temporaryKey).catch(() => undefined);
  }

  const revisionId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await env.PROJECTS_DB.prepare(
      `INSERT OR IGNORE INTO project_revisions (
         id, project_id, commit_sha, ref, is_default_branch,
         inspection_version, inspection_status, inspection_findings,
         source_kind, source_bundle_key, source_bundle_digest, source_bundle_size,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, ?, 'pending', '[]', 'r2-bundle', ?, ?, ?, ?, ?)`,
    )
      .bind(
        revisionId,
        projectId,
        input.commitSha,
        input.ref,
        inspectionVersion,
        objectKey,
        input.bundleSha256,
        input.bundleSize,
        now,
        now,
      )
      .run();
    const row = await findSubmittedRevision(
      projectId,
      input.commitSha,
      env.PROJECTS_DB,
    );
    if (!row) throw new Error("Could not persist project revision");
    if (!sameBundleIdentity(row, input)) {
      if (storedByRequest) await env.REVISION_SOURCES.delete(objectKey);
      return Response.json(
        { error: "Commit already has a different revision source" },
        { status: 409 },
      );
    }
    const dispatch = await dispatchSubmittedRevision(row.id, projectId, env);
    if (dispatch) return dispatch;
    return submissionResponse(
      row.id,
      input.commitSha,
      row.id === revisionId ? "accepted" : "already-submitted",
      row.id === revisionId ? 202 : 200,
    );
  } catch (error) {
    const committed = await findSubmittedRevision(
      projectId,
      input.commitSha,
      env.PROJECTS_DB,
    ).catch(() => null);
    if (!committed && storedByRequest)
      await env.REVISION_SOURCES.delete(objectKey).catch(() => undefined);
    return platformFailure("Could not save the project revision", error);
  }
}

interface SubmittedRevisionRow {
  id: string;
  source_kind: "artifacts" | "r2-bundle";
  source_bundle_key: string | null;
  source_bundle_digest: string | null;
  source_bundle_size: number | null;
  ref: string;
}

class RevisionBundleTooLargeError extends Error {}

async function findSubmittedRevision(
  projectId: string,
  commitSha: string,
  db: D1Database,
) {
  return db
    .prepare(
      `SELECT id, source_kind, source_bundle_key, source_bundle_digest,
          source_bundle_size, ref FROM project_revisions
       WHERE project_id = ? AND commit_sha = ?`,
    )
    .bind(projectId, commitSha)
    .first<SubmittedRevisionRow>();
}

function sameBundleIdentity(
  row: SubmittedRevisionRow,
  input: { ref: string; bundleSha256: string; bundleSize: number },
): boolean {
  return (
    row.source_kind === "r2-bundle" &&
    row.ref === input.ref &&
    row.source_bundle_digest === input.bundleSha256 &&
    row.source_bundle_size === input.bundleSize
  );
}

function revisionBundleKey(
  projectId: string,
  commitSha: string,
  digest: string,
): string {
  return `projects/${projectId}/revisions/${commitSha}/${digest}.bundle`;
}

async function consumeVerifiedBundle(
  stream: ReadableStream<Uint8Array>,
  expectedSize: number,
  expectedDigest: string,
): Promise<void> {
  const hash = createHash("sha256");
  const reader = stream.getReader();
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > revisionBundleMaxBytes || bytes > expectedSize) {
      await reader.cancel();
      throw new RevisionBundleTooLargeError();
    }
    hash.update(value);
  }
  if (bytes !== expectedSize || hash.digest("hex") !== expectedDigest) {
    throw new Error("Revision bundle identity does not match");
  }
}

async function pipeVerifiedBundle(
  source: ReadableStream<Uint8Array>,
  destination: WritableStream<Uint8Array>,
  expectedSize: number,
  expectedDigest: string,
): Promise<void> {
  const hash = createHash("sha256");
  const reader = source.getReader();
  const writer = destination.getWriter();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > revisionBundleMaxBytes || bytes > expectedSize) {
        await reader.cancel();
        throw new RevisionBundleTooLargeError();
      }
      hash.update(value);
      await writer.write(value);
    }
    if (bytes !== expectedSize || hash.digest("hex") !== expectedDigest) {
      throw new Error("Revision bundle identity does not match");
    }
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    throw error;
  }
}

function digestBytes(digest: string): ArrayBuffer {
  const bytes = Uint8Array.from(digest.match(/../g)!, (value) =>
    Number.parseInt(value, 16),
  );
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

function validBundleObject(
  object: R2Object | null,
  projectId: string,
  input: {
    commitSha: string;
    ref: string;
    bundleSha256: string;
    bundleSize: number;
  },
): boolean {
  return (
    object?.size === input.bundleSize &&
    object.httpMetadata?.contentType === "application/x-git-bundle" &&
    object.customMetadata?.projectId === projectId &&
    object.customMetadata.commitSha === input.commitSha &&
    object.customMetadata.ref === input.ref &&
    object.customMetadata.sha256 === input.bundleSha256 &&
    object.customMetadata.byteSize === String(input.bundleSize) &&
    object.checksums.sha256 !== undefined &&
    Array.from(new Uint8Array(object.checksums.sha256), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("") === input.bundleSha256
  );
}

async function dispatchSubmittedRevision(
  revisionId: string,
  projectId: string,
  env: RevisionSubmissionEnv,
): Promise<Response | undefined> {
  const instanceId = `revision-${revisionId}`;
  try {
    const [created] = await env.REVISION_WORKFLOW.createBatch([
      {
        id: instanceId,
        params: { kind: "submitted-revision", projectId, revisionId },
      },
    ]);
    if (created) return undefined;
    const existing = await env.REVISION_WORKFLOW.get(instanceId);
    const status = await existing.status();
    if (["complete", "errored", "terminated"].includes(status.status)) {
      await existing.restart();
    }
    return undefined;
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Could not dispatch submitted revision",
        projectId,
        revisionId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return Response.json(
      {
        error: "Revision was saved but processing could not be started",
        revisionId,
      },
      { status: 503, headers: { "Retry-After": "1" } },
    );
  }
}

function submissionResponse(
  revisionId: string,
  commitSha: string,
  status: "accepted" | "already-submitted",
  responseStatus: number,
): Response {
  return Response.json(
    revisionBundleSubmissionResultSchema.parse({
      revisionId,
      commitSha,
      status,
    }),
    { status: responseStatus },
  );
}

function bundleReadFailure(error: BoundaryError): Response {
  if (error instanceof RevisionBundleTooLargeError) {
    return Response.json(
      { error: "Revision bundle exceeds 25 MiB" },
      { status: 413 },
    );
  }
  if (
    error instanceof Error &&
    error.message === "Revision bundle identity does not match"
  ) {
    return Response.json({ error: error.message }, { status: 422 });
  }
  return platformFailure("Could not store the revision bundle", error);
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
       FROM projects
       WHERE repository_name = ? AND authoring_source_kind = 'artifacts'`,
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
    ref: row.ref,
    inspectionStatus: row.inspection_status,
    source: {
      kind: "artifacts" as const,
      repositoryName: project.repository_name,
      repositoryRemoteUrl: project.repository_remote_url,
    },
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
  if (target.source.kind !== "artifacts") {
    throw new Error("Bundle revisions must be inspected in Sandbox");
  }
  const source = target.source;
  await readCommit(
    {
      commitSha: target.commitSha,
      repositoryName: source.repositoryName,
    },
    env,
    fetcher,
  );
  return inspectRevisionStructure((path) =>
    readFile(
      {
        commitSha: target.commitSha,
        repositoryName: source.repositoryName,
      },
      path,
      env,
      fetcher,
    ),
  );
}

export async function inspectRevisionStructure(
  read: (path: string) => Promise<string>,
): Promise<InspectionResult> {
  const findings: RevisionFinding[] = [];

  let packageText: string;
  try {
    packageText = await read("package.json");
  } catch (error) {
    if (error instanceof RevisionContentError && error.kind === "too-large") {
      return invalid(
        "package.too-large",
        "package.json exceeds the 1 MB inspection limit",
        "package.json",
      );
    }
    if (error instanceof RevisionContentError && error.kind === "not-found") {
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
    requiredFiles.map((path) => read(path)),
  );
  for (let index = 0; index < fileResults.length; index += 1) {
    const result = fileResults[index];
    if (result?.status === "rejected") {
      if (
        !(result.reason instanceof RevisionContentError) ||
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
  sourceProvenance?: string,
): Promise<boolean> {
  const findings = JSON.stringify(result.findings.slice(0, 100));
  const updated = await db
    .prepare(
      `UPDATE project_revisions
          SET inspection_status = ?, inspection_findings = ?,
              source_provenance = COALESCE(?, source_provenance), updated_at = ?
          WHERE id = ? AND inspection_status IN ('pending', 'error')`,
    )
    .bind(
      result.status,
      findings,
      sourceProvenance ?? null,
      new Date().toISOString(),
      revisionId,
    )
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
    `SELECT r.id AS revision_id, r.commit_sha, r.source_kind,
        r.source_provenance, p.repository_name
       FROM projects p
       JOIN project_revisions r ON r.project_id = p.id
       JOIN revision_builds b ON b.revision_id = r.id
       WHERE p.id = ? AND p.owner_email = ? AND r.id = ? AND b.status = 'ready'`,
  )
    .bind(projectId, ownerEmail, revisionId)
    .first<ProvenanceRevisionRow>();
  if (!revision) return provenanceNotFound();

  let markdown: string;
  if (revision.source_kind === "r2-bundle") {
    if (!revision.source_provenance) return provenanceNotFound();
    markdown = revision.source_provenance;
  } else {
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
      if (error instanceof RevisionContentError) {
        if (error.kind === "not-found") return provenanceNotFound();
        if (error.kind === "too-large") return invalidProvenance();
        return Response.json(
          { error: "Source provenance is temporarily unavailable" },
          { status: 502 },
        );
      }
      throw error;
    }
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
    throw new RevisionContentError(
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
    throw new RevisionContentError("Artifacts file exceeds 1 MB", "too-large");
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
      throw new RevisionContentError(
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
