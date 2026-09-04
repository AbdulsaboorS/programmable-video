import {
  agentHandoffSchema,
  createManagedProjectRequestSchema,
  createProjectFeedbackRequestSchema,
  managedProjectSchema,
  projectBriefSchema,
  projectFeedbackSchema,
  saveProjectBriefRequestSchema,
  videoSpec,
  type ManagedProject,
  type ProjectFeedback,
  type ReferenceMetadata,
} from "@programmable-video/contracts";
import { z } from "zod";

import { readLimitedBody, RequestTooLargeError } from "./api";
import {
  createAgentReferenceDownloads,
  type AgentReferenceEnv,
} from "./project-references";
import { isUuid, platformFailure } from "./worker-utils";

const localDefaultBranch = "main";
const handoffTtlSeconds = 60 * 60;

export interface ProjectApiEnv extends AgentReferenceEnv {
  PROJECTS_DB: D1Database;
}

interface ProjectRow {
  id: string;
  request_id: string | null;
  name: string;
  status: ManagedProject["status"];
  source_host: string;
  source_project_path: string;
  source_web_url: string;
  source_default_branch: string;
  source_selected_ref: string;
  default_branch: string;
  video_brief: string | null;
  video_brief_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ReferenceRow {
  id: string;
  file_name: string;
  media_type: string;
  byte_size: number;
  note: string;
  storage_state: "metadata-only" | "uploaded";
  object_key: string | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
  created_at: string;
}

interface FeedbackRow {
  id: string;
  project_id: string;
  revision_id: string;
  frame: number;
  fps: typeof videoSpec.fps;
  duration_in_frames: 360 | 450;
  feedback: string;
  created_at: string;
}

export async function listProjects(
  ownerEmail: string,
  env: ProjectApiEnv,
): Promise<Response> {
  try {
    const rows = await env.PROJECTS_DB.prepare(
      "SELECT * FROM projects WHERE owner_email = ? ORDER BY updated_at DESC",
    )
      .bind(ownerEmail)
      .all<ProjectRow>();
    const projects = await Promise.all(
      rows.results.map((row) => projectFromRow(row, env.PROJECTS_DB)),
    );
    return Response.json({ projects });
  } catch (error) {
    return platformFailure("Could not load product projects", error);
  }
}

export async function getProject(
  projectId: string,
  ownerEmail: string,
  env: ProjectApiEnv,
): Promise<Response> {
  try {
    const row = await findProject(projectId, ownerEmail, env.PROJECTS_DB);
    if (!row) return notFound();
    return Response.json(await projectFromRow(row, env.PROJECTS_DB));
  } catch (error) {
    return platformFailure("Could not load the product project", error);
  }
}

export async function createProject(
  request: Request,
  ownerEmail: string,
  env: ProjectApiEnv,
): Promise<Response> {
  const parsed = await parseBody(request, createManagedProjectRequestSchema);
  if (!parsed.success) return parsed.response;

  const source = parseGitHubSource(
    parsed.data.githubUrl,
    parsed.data.defaultBranch,
  );
  if (!source) {
    return Response.json(
      { error: "Invalid GitHub repository URL" },
      { status: 400 },
    );
  }

  try {
    const existing = await findProjectByRequest(
      ownerEmail,
      parsed.data.requestId,
      env.PROJECTS_DB,
    );
    if (existing) {
      if (!matchesProjectRequest(existing, parsed.data.name, source)) {
        return Response.json(
          { error: "Idempotency key already used" },
          { status: 409 },
        );
      }
      return Response.json(await projectFromRow(existing, env.PROJECTS_DB));
    }
  } catch (error) {
    return platformFailure("Could not check the product project", error);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    await env.PROJECTS_DB.prepare(
      `INSERT INTO projects (
        id, owner_email, request_id, name, status,
        source_host, source_project_path, source_web_url,
        source_default_branch, source_selected_ref,
        default_branch,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        ownerEmail,
        parsed.data.requestId,
        parsed.data.name,
        source.host,
        source.projectPath,
        source.webUrl,
        source.defaultBranch,
        source.selectedRef,
        localDefaultBranch,
        now,
        now,
      )
      .run();
  } catch (error) {
    try {
      const existing = await findProjectByRequest(
        ownerEmail,
        parsed.data.requestId,
        env.PROJECTS_DB,
      );
      if (existing) {
        if (!matchesProjectRequest(existing, parsed.data.name, source)) {
          return Response.json(
            { error: "Idempotency key already used" },
            { status: 409 },
          );
        }
        return Response.json(await projectFromRow(existing, env.PROJECTS_DB));
      }
    } catch (lookupError) {
      console.error(
        JSON.stringify({
          message: "Could not reconcile an idempotent project request",
          error:
            lookupError instanceof Error
              ? lookupError.message
              : String(lookupError),
        }),
      );
    }
    return platformFailure("Could not save the product project", error);
  }

  return Response.json(
    managedProjectSchema.parse({
      id,
      name: parsed.data.name,
      status: "ready",
      source,
      repository: {
        kind: "local",
        defaultBranch: localDefaultBranch,
        state: "initialized",
      },
      references: [],
      brief: null,
      feedback: [],
      createdAt: now,
      updatedAt: now,
    }),
    { status: 201 },
  );
}

export async function saveProjectBrief(
  request: Request,
  projectId: string,
  ownerEmail: string,
  env: ProjectApiEnv,
): Promise<Response> {
  const parsed = await parseBody(request, saveProjectBriefRequestSchema);
  if (!parsed.success) return parsed.response;
  let project: ProjectRow | null;
  try {
    project = await findProject(projectId, ownerEmail, env.PROJECTS_DB);
  } catch (error) {
    return platformFailure("Could not load the product project", error);
  }
  if (!project) return notFound();

  const brief = projectBriefSchema.parse({
    text: parsed.data.text,
    updatedAt: new Date().toISOString(),
  });
  try {
    await env.PROJECTS_DB.prepare(
      `UPDATE projects
       SET video_brief = ?, video_brief_updated_at = ?, updated_at = ?
       WHERE id = ? AND owner_email = ?`,
    )
      .bind(brief.text, brief.updatedAt, brief.updatedAt, projectId, ownerEmail)
      .run();
  } catch (error) {
    return platformFailure("Could not save the video brief", error);
  }
  return Response.json(brief);
}

export async function createProjectFeedback(
  request: Request,
  projectId: string,
  ownerEmail: string,
  env: ProjectApiEnv,
): Promise<Response> {
  const parsed = await parseBody(request, createProjectFeedbackRequestSchema);
  if (!parsed.success) return parsed.response;
  let project: ProjectRow | null;
  try {
    project = await findProject(projectId, ownerEmail, env.PROJECTS_DB);
  } catch (error) {
    return platformFailure("Could not load the product project", error);
  }
  if (!project) return notFound();

  try {
    const revision = await env.PROJECTS_DB.prepare(
      `SELECT r.id FROM project_revisions r
       JOIN revision_builds b ON b.revision_id = r.id
       WHERE r.id = ? AND r.project_id = ? AND b.status = 'ready'
         AND b.fps = ? AND b.duration_in_frames = ?`,
    )
      .bind(
        parsed.data.revisionId,
        projectId,
        parsed.data.fps,
        parsed.data.durationInFrames,
      )
      .first<{ id: string }>();
    if (!revision) {
      return Response.json(
        { error: "Ready project revision not found" },
        { status: 404 },
      );
    }

    const existing = await findFeedback(parsed.data.id, env.PROJECTS_DB);
    if (existing) {
      return existing.project_id === projectId
        ? feedbackRetryResponse(existing, parsed.data)
        : feedbackIdConflict();
    }

    const feedback = projectFeedbackSchema.parse({
      ...parsed.data,
      createdAt: new Date().toISOString(),
    });
    try {
      await env.PROJECTS_DB.prepare(
        `INSERT INTO project_feedback (
          id, project_id, revision_id, frame, fps, duration_in_frames,
          feedback, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          feedback.id,
          projectId,
          feedback.revisionId,
          feedback.frame,
          feedback.fps,
          feedback.durationInFrames,
          feedback.text,
          feedback.createdAt,
        )
        .run();
    } catch (error) {
      const committed = await findFeedback(feedback.id, env.PROJECTS_DB);
      if (committed) {
        return committed.project_id === projectId
          ? feedbackRetryResponse(committed, parsed.data)
          : feedbackIdConflict();
      }
      throw error;
    }
    return Response.json(feedback, { status: 201 });
  } catch (error) {
    return platformFailure("Could not save the change feedback", error);
  }
}

export async function createHandoff(
  projectId: string,
  ownerEmail: string,
  env: ProjectApiEnv,
  studioOrigin = env.STUDIO_ORIGIN,
): Promise<Response> {
  let project: ProjectRow | null;
  try {
    project = await findProject(projectId, ownerEmail, env.PROJECTS_DB);
  } catch (error) {
    return platformFailure("Could not load the product project", error);
  }
  if (!project) return notFound();

  const tokenExpiresAt = new Date(
    Date.now() + handoffTtlSeconds * 1000,
  ).toISOString();
  try {
    const references = await createAgentReferenceDownloads(
      projectId,
      ownerEmail,
      tokenExpiresAt,
      env,
      studioOrigin,
    );
    const response = agentHandoffSchema.parse({
      kind: "local",
      projectId,
      defaultBranch: project.default_branch,
      tokenExpiresAt,
      references,
    });
    return Response.json(response, {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return platformFailure("Could not create an agent handoff", error);
  }
}

function parseGitHubSource(githubUrl: string, defaultBranch: string) {
  const url = new URL(githubUrl);
  if (
    url.protocol !== "https:" ||
    url.host !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return undefined;
  }
  const encodedPath = url.pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "");
  if (
    !encodedPath ||
    /%(?:2f|3f|23|0[0-9a-f]|1[0-9a-f]|7f)/i.test(encodedPath)
  ) {
    return undefined;
  }
  let parts: string[];
  try {
    parts = encodedPath.split("/").map(decodeURIComponent);
  } catch {
    return undefined;
  }
  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        Array.from(part).some((character) => character <= "\u001f"),
    )
  ) {
    return undefined;
  }
  const projectPath = parts.join("/");
  return {
    provider: "github" as const,
    host: url.host,
    projectPath,
    webUrl: `${url.origin}/${parts.map(encodeURIComponent).join("/")}`,
    defaultBranch,
    selectedRef: defaultBranch,
  };
}

function matchesProjectRequest(
  row: ProjectRow,
  name: string,
  source: ReturnType<typeof parseGitHubSource> & {},
): boolean {
  return (
    row.name === name &&
    row.source_host === source.host &&
    row.source_project_path === source.projectPath &&
    row.source_web_url === source.webUrl &&
    row.source_default_branch === source.defaultBranch &&
    row.source_selected_ref === source.selectedRef
  );
}

async function findProjectByRequest(
  ownerEmail: string,
  requestId: string,
  database: D1Database,
): Promise<ProjectRow | null> {
  return database
    .prepare("SELECT * FROM projects WHERE owner_email = ? AND request_id = ?")
    .bind(ownerEmail, requestId)
    .first<ProjectRow>();
}

async function findProject(
  projectId: string,
  ownerEmail: string,
  database: D1Database,
): Promise<ProjectRow | null> {
  if (!isUuid(projectId)) return null;
  return database
    .prepare("SELECT * FROM projects WHERE id = ? AND owner_email = ?")
    .bind(projectId, ownerEmail)
    .first<ProjectRow>();
}

async function projectFromRow(
  row: ProjectRow,
  database: D1Database,
): Promise<ManagedProject> {
  const [referenceRows, feedbackRows] = await Promise.all([
    database
      .prepare(
        "SELECT * FROM project_references WHERE project_id = ? ORDER BY created_at ASC",
      )
      .bind(row.id)
      .all<ReferenceRow>(),
    database
      .prepare(
        "SELECT * FROM project_feedback WHERE project_id = ? ORDER BY created_at ASC",
      )
      .bind(row.id)
      .all<FeedbackRow>(),
  ]);
  return managedProjectSchema.parse({
    id: row.id,
    name: row.name,
    status: row.status,
    source: {
      provider: row.source_host === "github.com" ? "github" : "gitlab",
      host: row.source_host,
      projectPath: row.source_project_path,
      webUrl: row.source_web_url,
      defaultBranch: row.source_default_branch,
      selectedRef: row.source_selected_ref,
    },
    repository: {
      kind: "local",
      defaultBranch: row.default_branch,
      state: "initialized",
    },
    references: referenceRows.results.map(referenceFromRow),
    brief:
      row.video_brief && row.video_brief_updated_at
        ? { text: row.video_brief, updatedAt: row.video_brief_updated_at }
        : null,
    feedback: feedbackRows.results.map(feedbackFromRow),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function feedbackFromRow(row: FeedbackRow): ProjectFeedback {
  return {
    id: row.id,
    revisionId: row.revision_id,
    frame: row.frame,
    fps: row.fps,
    durationInFrames: row.duration_in_frames,
    text: row.feedback,
    createdAt: row.created_at,
  };
}

async function findFeedback(
  id: string,
  database: D1Database,
): Promise<FeedbackRow | null> {
  return database
    .prepare("SELECT * FROM project_feedback WHERE id = ?")
    .bind(id)
    .first<FeedbackRow>();
}

function feedbackRetryResponse(
  row: FeedbackRow,
  input: {
    revisionId: string;
    frame: number;
    fps: number;
    durationInFrames: number;
    text: string;
  },
): Response {
  const existing = feedbackFromRow(row);
  if (
    existing.revisionId !== input.revisionId ||
    existing.frame !== input.frame ||
    existing.fps !== input.fps ||
    existing.durationInFrames !== input.durationInFrames ||
    existing.text !== input.text
  ) {
    return Response.json(
      { error: "Feedback id already used" },
      { status: 409 },
    );
  }
  return Response.json(existing);
}

function feedbackIdConflict(): Response {
  return Response.json({ error: "Feedback id already used" }, { status: 409 });
}

function referenceFromRow(row: ReferenceRow): ReferenceMetadata {
  const base = {
    id: row.id,
    fileName: row.file_name,
    mediaType: row.media_type,
    byteSize: row.byte_size,
    note: row.note,
    createdAt: row.created_at,
  };
  return row.storage_state === "uploaded"
    ? {
        ...base,
        mediaType: "image/png",
        storageState: "uploaded",
        width: row.width!,
        height: row.height!,
      }
    : { ...base, storageState: "metadata-only" };
}

async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<
  { success: true; data: z.output<T> } | { success: false; response: Response }
> {
  try {
    const result = schema.safeParse(JSON.parse(await readLimitedBody(request)));
    if (result.success) return result;
    return {
      success: false,
      response: Response.json({ error: "Invalid request" }, { status: 400 }),
    };
  } catch (error) {
    return {
      success: false,
      response: Response.json(
        {
          error:
            error instanceof RequestTooLargeError
              ? "Request exceeds 1 MB"
              : "Invalid request",
        },
        { status: error instanceof RequestTooLargeError ? 413 : 400 },
      ),
    };
  }
}

function notFound(): Response {
  return Response.json({ error: "Project not found" }, { status: 404 });
}
