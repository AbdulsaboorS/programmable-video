import { z } from "zod";

import { videoSpec } from "./video-spec";

export {
  managedVideoMaxDurationSeconds,
  managedVideoDurationInFramesSchema,
  managedVideoFpsSchema,
  managedVideoSpecSchema,
  videoSpec,
  type ManagedVideoSpec,
  type VideoSpec,
} from "./video-spec";

export const previewCapabilitySchema = z
  .object({
    version: z.literal(1),
    projectId: z.string().min(1),
    revisionId: z.string().min(1),
    commitSha: z.string().min(1),
    attempt: z.number().int().positive(),
    prefix: z.string().min(1),
    manifestDigest: z.string().min(1),
    owner: z.string().min(1),
    expiresAt: z.number().int(),
  })
  .strict();

export type PreviewCapability = z.infer<typeof previewCapabilitySchema>;

export const renderFailureSchema = z
  .object({
    stage: z.enum(["validation", "render", "upload", "processing"]),
    message: z.string(),
  })
  .strict();

export const rendererErrorResponseSchema = z
  .object({ error: renderFailureSchema })
  .strict();

export const renderStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("queued") }).strict(),
  z.object({ status: z.literal("rendering") }).strict(),
  z
    .object({
      status: z.literal("ready"),
      videoId: z.string(),
      previewUrl: z.url(),
      hlsUrl: z.url(),
      thumbnailUrl: z.url(),
    })
    .strict(),
  z
    .object({ status: z.literal("failed"), error: renderFailureSchema })
    .strict(),
]);

export type RenderStatus = z.infer<typeof renderStatusSchema>;

export function frameToSeconds(frame: number): number {
  return frame / videoSpec.fps;
}

export function formatTime(frame: number): string {
  const totalSeconds = frameToSeconds(frame);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const milliseconds = Math.floor((totalSeconds % 1) * 1000);

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

export {
  defineCompositionManifest,
  type CompositionField,
  type CompositionManifest,
  type FlatStringPropsSchema,
  type InferCompositionProps,
} from "./composition-manifest";

export {
  agentHandoffSchema,
  createProjectFeedbackRequestSchema,
  createManagedProjectRequestSchema,
  createReferenceUploadRequestSchema,
  sourceRepositorySchema,
  managedProjectListSchema,
  managedProjectSchema,
  managedRepositorySchema,
  localAgentHandoffSchema,
  localManagedRepositorySchema,
  projectBriefSchema,
  projectFeedbackSchema,
  referenceMetadataSchema,
  referenceImageMaxBytes,
  referenceImageMaxDimension,
  referenceImageMaxPixels,
  saveProjectBriefRequestSchema,
  type AgentHandoff,
  type CreateManagedProjectRequest,
  type CreateProjectFeedbackRequest,
  type ManagedProject,
  type ManagedRepository,
  type LocalAgentHandoff,
  type LocalManagedRepository,
  type ProjectBrief,
  type ProjectFeedback,
  type ReferenceMetadata,
  type SaveProjectBriefRequest,
} from "./managed-project";

export {
  gitBranchRefSchema,
  gitShaSchema,
  managedRenderStatusSchema,
  managedContainerRenderRequestSchema,
  previewSessionSchema,
  projectRevisionListSchema,
  projectRevisionSchema,
  revisionApprovalSummarySchema,
  revisionArtifactFileSchema,
  revisionArtifactManifestSchema,
  revisionBuildStatusSchema,
  revisionBuildSummarySchema,
  revisionBuildRetrySchema,
  revisionCheckNameSchema,
  revisionCheckResultSchema,
  revisionFindingSchema,
  revisionInspectionStatusSchema,
  revisionBundleMaxBytes,
  revisionBundleSubmissionResultSchema,
  revisionBundleSubmissionSchema,
  revisionSubmissionWorkflowCommandSchema,
  sourceProvenanceSchema,
  type ProjectRevision,
  type ManagedRenderStatus,
  type PreviewSession,
  type RevisionApprovalSummary,
  type RevisionArtifactFile,
  type RevisionArtifactManifest,
  type RevisionBuildStatus,
  type RevisionBuildRetry,
  type RevisionCheckName,
  type RevisionCheckResult,
  type RevisionFinding,
  type RevisionInspectionStatus,
  type RevisionBundleSubmission,
  type RevisionBundleSubmissionResult,
  type RevisionSubmissionWorkflowCommand,
  type SourceProvenance,
} from "./project-revision";

export { isoTimestampSchema, sha256Schema } from "./shared";

export {
  captionStatusSchema,
  createNoOpFinishingSpec,
  createPublicationRequestSchema,
  downloadStatusSchema,
  finishingAudioMaxBytes,
  finishingAudioMaxDurationMs,
  finishingAudioSchema,
  finishingCaptionMaxBytes,
  finishingCaptionSchema,
  finishingContainBackground,
  finishingFitSchema,
  finishingOutputSchema,
  finishingProfiles,
  finishingProfileSchema,
  finishingSpecSchema,
  finishingSpecVersion,
  finishingTrimSchema,
  managedPublicationHistorySchema,
  managedPublicationSchema,
  mediaAssetValidationStatusSchema,
  playbackStatusSchema,
  projectMediaAssetSchema,
  publicationAttemptSchema,
  publicationAttemptStatusSchema,
  publicationIdempotencyKeySchema,
  publicationStatusSchema,
  type CreatePublicationRequest,
  type FinishingFit,
  type FinishingProfile,
  type FinishingSpec,
  type ManagedPublication,
  type ProjectMediaAsset,
  type PublicationAttempt,
} from "./finishing";
