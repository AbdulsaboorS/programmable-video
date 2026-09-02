import {
  agentHandoffSchema,
  createPublicationRequestSchema,
  managedPublicationHistorySchema,
  managedPublicationSchema,
  projectBriefSchema,
  projectFeedbackSchema,
  managedProjectListSchema,
  managedProjectSchema,
  projectRevisionListSchema,
  previewSessionSchema,
  referenceMetadataSchema,
  revisionApprovalSummarySchema,
  revisionBuildRetrySchema,
  sourceProvenanceSchema,
  managedRenderStatusSchema,
  projectMediaAssetSchema,
  type AgentHandoff,
  type CreatePublicationRequest,
  type CreateManagedProjectRequest,
  type CreateProjectFeedbackRequest,
  type ManagedProject,
  type ManagedPublication,
  type ProjectBrief,
  type ProjectFeedback,
  type ProjectRevision,
  type PreviewSession,
  type RevisionApprovalSummary,
  type RevisionBuildRetry,
  type ManagedRenderStatus,
  type ReferenceMetadata,
  type ProjectMediaAsset,
  type SourceProvenance,
  type SaveProjectBriefRequest,
} from "@programmable-video/contracts";
import { z } from "zod";

const projectMediaListSchema = z
  .object({ assets: z.array(projectMediaAssetSchema).max(1_000) })
  .strict();

const apiErrorSchema = z.object({ error: z.string() }).passthrough();
const apiJsonSchema = z.json();
type ApiJson = z.infer<typeof apiJsonSchema>;

async function requestJson(url: string, init?: RequestInit): Promise<ApiJson> {
  const response = await fetch(url, init);
  const parsedJson = apiJsonSchema.safeParse(
    await response.json().catch(() => null),
  );
  const value = parsedJson.success ? parsedJson.data : null;
  if (!response.ok) {
    const parsedError = apiErrorSchema.safeParse(value);
    const message = parsedError.success
      ? parsedError.data.error
      : `Request failed with status ${response.status}`;
    throw new Error(message);
  }
  return value;
}

function jsonPost<RequestBody>(body?: RequestBody): RequestInit {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

function jsonPut<RequestBody>(body: RequestBody): RequestInit {
  return {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function loadProjects(
  signal?: AbortSignal,
): Promise<ManagedProject[]> {
  const value = await requestJson(
    "/api/projects",
    signal ? { signal } : undefined,
  );
  const parsed = managedProjectListSchema.safeParse(value);
  if (!parsed.success) throw new Error("Project API returned invalid data");
  return parsed.data.projects;
}

export async function loadRevisions(
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectRevision[]> {
  const value = await requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/revisions`,
    signal ? { signal } : undefined,
  );
  const parsed = projectRevisionListSchema.safeParse(value);
  if (!parsed.success) throw new Error("Revision API returned invalid data");
  return parsed.data.revisions;
}

export async function loadSourceProvenance(
  projectId: string,
  revisionId: string,
  signal?: AbortSignal,
): Promise<SourceProvenance> {
  const value = await requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/provenance`,
    signal ? { signal } : undefined,
  );
  const parsed = sourceProvenanceSchema.safeParse(value);
  if (!parsed.success) throw new Error("Provenance API returned invalid data");
  return parsed.data;
}

export async function addProject(
  input: CreateManagedProjectRequest,
): Promise<ManagedProject> {
  const parsed = managedProjectSchema.safeParse(
    await requestJson("/api/projects", jsonPost(input)),
  );
  if (!parsed.success) throw new Error("Project API returned invalid data");
  return parsed.data;
}

export async function addReference(
  projectId: string,
  file: File,
  representedState: string,
): Promise<ReferenceMetadata> {
  const form = new FormData();
  form.set("file", file);
  form.set("representedState", representedState);
  const parsed = referenceMetadataSchema.safeParse(
    await requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/references`,
      { method: "POST", body: form },
    ),
  );
  if (!parsed.success) throw new Error("Project API returned invalid data");
  return parsed.data;
}

export function referenceContentUrl(
  projectId: string,
  referenceId: string,
): string {
  return `/api/projects/${encodeURIComponent(projectId)}/references/${encodeURIComponent(referenceId)}/content`;
}

export async function createAgentHandoff(
  projectId: string,
): Promise<AgentHandoff> {
  const parsed = agentHandoffSchema.safeParse(
    await requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/handoffs`,
      jsonPost(),
    ),
  );
  if (!parsed.success) throw new Error("Project API returned invalid data");
  return parsed.data;
}

export async function saveVideoBrief(
  projectId: string,
  input: SaveProjectBriefRequest,
): Promise<ProjectBrief> {
  const parsed = projectBriefSchema.safeParse(
    await requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/brief`,
      jsonPut(input),
    ),
  );
  if (!parsed.success) throw new Error("Project API returned invalid data");
  return parsed.data;
}

export async function saveChangeFeedback(
  projectId: string,
  input: CreateProjectFeedbackRequest,
): Promise<ProjectFeedback> {
  const parsed = projectFeedbackSchema.safeParse(
    await requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/feedback`,
      jsonPost(input),
    ),
  );
  if (!parsed.success) throw new Error("Project API returned invalid data");
  return parsed.data;
}

export async function createPreviewSession(
  projectId: string,
  revisionId: string,
): Promise<PreviewSession> {
  const parsed = previewSessionSchema.safeParse(
    await requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/preview-session`,
      jsonPost(),
    ),
  );
  if (!parsed.success) throw new Error("Preview API returned invalid data");
  return parsed.data;
}

export async function retryRevisionBuild(
  projectId: string,
  revisionId: string,
): Promise<RevisionBuildRetry> {
  const parsed = revisionBuildRetrySchema.safeParse(
    await requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/build-retry`,
      jsonPost(),
    ),
  );
  if (!parsed.success) throw new Error("Retry API returned invalid data");
  return parsed.data;
}

export async function approveProjectRevision(
  projectId: string,
  revisionId: string,
): Promise<RevisionApprovalSummary> {
  const parsed = revisionApprovalSummarySchema.safeParse(
    await requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/approval`,
      jsonPost(),
    ),
  );
  if (!parsed.success) throw new Error("Approval API returned invalid data");
  return parsed.data;
}

export async function renderProjectRevision(
  projectId: string,
  revisionId: string,
): Promise<ManagedRenderStatus> {
  const parsed = managedRenderStatusSchema.safeParse(
    await requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/renders`,
      jsonPost(),
    ),
  );
  if (!parsed.success) throw new Error("Render API returned invalid data");
  return parsed.data;
}

export async function loadPublications(
  projectId: string,
  signal?: AbortSignal,
): Promise<ManagedPublication[]> {
  const parsed = managedPublicationHistorySchema.safeParse(
    await requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/publications`,
      signal ? { signal } : undefined,
    ),
  );
  if (!parsed.success) {
    throw new Error("Publication API returned invalid data");
  }
  return parsed.data.publications;
}

export async function createPublication(
  projectId: string,
  revisionId: string,
  input: CreatePublicationRequest,
): Promise<ManagedPublication> {
  const request = createPublicationRequestSchema.parse(input);
  const parsed = managedPublicationSchema.safeParse(
    await requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/publications`,
      jsonPost(request),
    ),
  );
  if (!parsed.success) {
    throw new Error("Publication API returned invalid data");
  }
  return parsed.data;
}

export async function retryPublication(
  projectId: string,
  publicationId: string,
): Promise<ManagedPublication> {
  const parsed = managedPublicationSchema.safeParse(
    await requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/publications/${encodeURIComponent(publicationId)}/retry`,
      jsonPost(),
    ),
  );
  if (!parsed.success) {
    throw new Error("Publication API returned invalid data");
  }
  return parsed.data;
}

export async function loadProjectMedia(
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectMediaAsset[]> {
  const parsed = projectMediaListSchema.safeParse(
    await requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/media`,
      signal ? { signal } : undefined,
    ),
  );
  if (!parsed.success) throw new Error("Media API returned invalid data");
  return parsed.data.assets;
}

async function uploadProjectMedia(
  projectId: string,
  kind: "audio" | "captions",
  file: File,
): Promise<ProjectMediaAsset> {
  const form = new FormData();
  form.set("file", file);
  const parsed = projectMediaAssetSchema.safeParse(
    await requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/media/${kind}`,
      { method: "POST", body: form },
    ),
  );
  if (!parsed.success) throw new Error("Media API returned invalid data");
  return parsed.data;
}

export async function uploadProjectAudio(
  projectId: string,
  file: File,
): Promise<ProjectMediaAsset> {
  const asset = await uploadProjectMedia(projectId, "audio", file);
  if (asset.kind !== "audio" || asset.validationStatus !== "pending") {
    return asset;
  }
  return validateProjectAudio(projectId, asset.id);
}

export async function validateProjectAudio(
  projectId: string,
  assetId: string,
): Promise<ProjectMediaAsset> {
  const validated = projectMediaAssetSchema.safeParse(
    await requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(assetId)}/validate-audio`,
      jsonPost(),
    ),
  );
  if (!validated.success || validated.data.kind !== "audio") {
    throw new Error("Media API returned invalid data");
  }
  return validated.data;
}

export function uploadProjectCaptions(
  projectId: string,
  file: File,
): Promise<ProjectMediaAsset> {
  return uploadProjectMedia(projectId, "captions", file);
}
