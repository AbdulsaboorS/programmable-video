import { z } from "zod";

import {
  managedVideoDurationInFramesSchema,
  managedVideoFpsSchema,
} from "./video-spec";
import { gitBranchRefSchema } from "./project-revision";
import { isoTimestampSchema } from "./shared";

const boundedName = z.string().trim().min(1).max(80);
const boundedText = z.string().trim().min(1).max(500);
const videoInstruction = z.string().trim().min(1).max(1500);

const referenceMetadataMaxBytes = 25 * 1024 * 1024;
export const referenceImageMaxBytes = 10 * 1024 * 1024;
export const referenceImageMaxDimension = 4096;
export const referenceImageMaxPixels = 3840 * 2160;

export const sourceRepositorySchema = z
  .object({
    provider: z.enum(["github", "gitlab"]),
    host: z.string().min(1).max(253),
    projectPath: z.string().min(1).max(500),
    webUrl: z.url(),
    defaultBranch: z.string().min(1).max(255),
    selectedRef: z.string().min(1).max(255),
  })
  .strict();

export const createManagedProjectRequestSchema = z
  .object({
    requestId: z.uuid(),
    name: boundedName,
    githubUrl: z.url().refine(
      (value) => {
        const url = new URL(value);
        return url.protocol === "https:" && url.host === "github.com";
      },
      { message: "Enter an HTTPS github.com repository URL" },
    ),
    defaultBranch: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine(
        (branch) =>
          gitBranchRefSchema.safeParse(`refs/heads/${branch}`).success,
        { message: "Enter a valid Git branch name" },
      )
      .default("main"),
  })
  .strict();

export const managedRepositorySchema = z
  .object({
    name: z.string().min(1),
    remoteUrl: z.url(),
    defaultBranch: z.string().min(1),
    state: z.literal("seeded"),
  })
  .strict();

const referenceMetadataBaseSchema = z
  .object({
    id: z.uuid(),
    fileName: z.string().min(1).max(255),
    mediaType: z.string().min(1).max(127),
    byteSize: z.number().int().nonnegative().max(referenceMetadataMaxBytes),
    note: z.string().max(500),
    createdAt: z.string().min(1),
  })
  .strict();

export const referenceMetadataSchema = z
  .discriminatedUnion("storageState", [
    referenceMetadataBaseSchema.extend({
      storageState: z.literal("metadata-only"),
    }),
    referenceMetadataBaseSchema.extend({
      storageState: z.literal("uploaded"),
      mediaType: z.literal("image/png"),
      byteSize: z.number().int().positive().max(referenceImageMaxBytes),
      width: z.number().int().positive().max(referenceImageMaxDimension),
      height: z.number().int().positive().max(referenceImageMaxDimension),
    }),
  ])
  .refine(
    (reference) =>
      reference.storageState === "metadata-only" ||
      reference.width * reference.height <= referenceImageMaxPixels,
    { message: "Reference image has too many pixels" },
  );

export const createReferenceUploadRequestSchema = z
  .object({
    representedState: z.string().trim().min(1).max(500),
  })
  .strict();

export const projectBriefSchema = z
  .object({
    text: videoInstruction,
    updatedAt: z.string().min(1),
  })
  .strict();

export const saveProjectBriefRequestSchema = z
  .object({ text: videoInstruction })
  .strict();

const projectFeedbackBaseSchema = z
  .object({
    id: z.uuid(),
    revisionId: z.uuid(),
    frame: z.number().int().nonnegative(),
    fps: managedVideoFpsSchema,
    durationInFrames: managedVideoDurationInFramesSchema,
    text: videoInstruction,
    createdAt: z.string().min(1),
  })
  .strict();

export const projectFeedbackSchema = projectFeedbackBaseSchema.refine(
  (feedback) => feedback.frame < feedback.durationInFrames,
  {
    message: "Feedback frame must be within the video",
    path: ["frame"],
  },
);

export const createProjectFeedbackRequestSchema = projectFeedbackBaseSchema
  .pick({
    id: true,
    revisionId: true,
    frame: true,
    fps: true,
    durationInFrames: true,
    text: true,
  })
  .strict()
  .refine((feedback) => feedback.frame < feedback.durationInFrames, {
    message: "Feedback frame must be within the video",
    path: ["frame"],
  });

export const managedProjectSchema = z
  .object({
    id: z.uuid(),
    name: boundedName,
    status: z.enum(["provisioning", "ready", "failed"]),
    source: sourceRepositorySchema,
    repository: managedRepositorySchema,
    references: z.array(referenceMetadataSchema),
    brief: projectBriefSchema.nullable(),
    feedback: z.array(projectFeedbackSchema),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export const managedProjectListSchema = z
  .object({ projects: z.array(managedProjectSchema) })
  .strict();

export const agentHandoffSchema = z
  .object({
    remoteUrl: z.url(),
    token: boundedText,
    tokenExpiresAt: isoTimestampSchema,
    defaultBranch: z.string().min(1),
    references: z.array(
      z
        .object({
          id: z.uuid(),
          fileName: z.string().min(1).max(255),
          downloadUrl: z
            .url()
            .refine((value) => new URL(value).protocol === "https:", {
              message: "Reference download URL must use HTTPS",
            }),
          token: z.string().min(1).max(4096),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .strict(),
    ),
  })
  .strict();

export type AgentHandoff = z.infer<typeof agentHandoffSchema>;
export type CreateManagedProjectRequest = z.infer<
  typeof createManagedProjectRequestSchema
>;
export type CreateProjectFeedbackRequest = z.infer<
  typeof createProjectFeedbackRequestSchema
>;
export type ManagedProject = z.infer<typeof managedProjectSchema>;
export type ProjectBrief = z.infer<typeof projectBriefSchema>;
export type ProjectFeedback = z.infer<typeof projectFeedbackSchema>;
export type ReferenceMetadata = z.infer<typeof referenceMetadataSchema>;
export type SaveProjectBriefRequest = z.infer<
  typeof saveProjectBriefRequestSchema
>;
