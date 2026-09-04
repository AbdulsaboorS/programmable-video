import { z } from "zod";

import { finishingSpecSchema } from "./finishing";
import { isoTimestampSchema, sha256Schema } from "./shared";

export const gitShaSchema = z.string().regex(/^[0-9a-fA-F]{40}$/);
export const revisionBundleMaxBytes = 25 * 1024 * 1024;

function isValidGitRef(ref: string): boolean {
  if (!ref.startsWith("refs/") || ref.length > 1024) {
    return false;
  }

  const name = ref.slice("refs/".length);
  const components = name.split("/");
  const hasOnlyGitRefCharacters = Array.from(name).every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint > 32 && codePoint !== 127 && !"~^:?*[\\".includes(character)
    );
  });

  return (
    name.length > 0 &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.includes("..") &&
    !name.includes("@{") &&
    hasOnlyGitRefCharacters &&
    components.every(
      (component) =>
        component.length > 0 &&
        !component.startsWith(".") &&
        !component.endsWith(".lock"),
    )
  );
}

const gitRefSchema = z.string().refine(isValidGitRef, {
  message: "Expected a valid Git ref",
});

export const gitBranchRefSchema = gitRefSchema.refine(
  (ref) => ref.startsWith("refs/heads/"),
  {
    message: "Expected a valid refs/heads Git ref",
  },
);

export const revisionBundleSubmissionSchema = z
  .object({
    commitSha: gitShaSchema,
    ref: gitBranchRefSchema,
    bundleSha256: sha256Schema,
    bundleSize: z.number().int().positive().max(revisionBundleMaxBytes),
  })
  .strict();

export const revisionBundleSubmissionResultSchema = z
  .object({
    revisionId: z.uuid(),
    commitSha: gitShaSchema,
    status: z.enum(["accepted", "already-submitted"]),
  })
  .strict();

export const revisionSubmissionWorkflowCommandSchema = z
  .object({
    kind: z.literal("submitted-revision"),
    projectId: z.uuid(),
    revisionId: z.uuid(),
  })
  .strict();

export const revisionInspectionStatusSchema = z.enum([
  "pending",
  "valid",
  "invalid",
  "error",
]);

export const revisionFindingSchema = z
  .object({
    severity: z.enum(["error", "warning"]),
    code: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
    message: z.string().trim().min(1).max(1_000),
    path: z.string().min(1).max(500).optional(),
    line: z.number().int().positive().max(10_000_000).optional(),
    column: z.number().int().positive().max(10_000_000).optional(),
  })
  .strict();

export const revisionCheckNameSchema = z.enum([
  "install",
  "format",
  "typecheck",
  "test",
  "build",
]);

export const revisionCheckResultSchema = z
  .object({
    name: revisionCheckNameSchema,
    status: z.enum(["passed", "failed", "error"]),
    exitCode: z.number().int().min(0).max(255).nullable(),
    durationMs: z
      .number()
      .int()
      .nonnegative()
      .max(15 * 60 * 1_000),
    stdout: z.string().max(65_536),
    stderr: z.string().max(65_536),
  })
  .strict();

export const revisionBuildStatusSchema = z.enum([
  "queued",
  "running",
  "invalid",
  "error",
  "ready",
]);

export const revisionBuildSummarySchema = z
  .object({
    status: revisionBuildStatusSchema,
    attempt: z.number().int().positive().max(1_000),
    checks: z.array(revisionCheckResultSchema).max(5),
    manifestDigest: sha256Schema.nullable(),
    inputDigest: sha256Schema.nullable(),
    startedAt: isoTimestampSchema.nullable(),
    completedAt: isoTimestampSchema.nullable(),
  })
  .strict();

export const revisionBuildRetrySchema = z
  .object({
    status: z.literal("queued"),
    attempt: z.number().int().positive().max(1_000),
  })
  .strict();

export type RevisionBuildRetry = z.infer<typeof revisionBuildRetrySchema>;

export const revisionArtifactFileSchema = z
  .object({
    path: z.string().min(1).max(500),
    size: z
      .number()
      .int()
      .nonnegative()
      .max(100 * 1024 * 1024),
    mediaType: z.string().min(1).max(255),
    digest: sha256Schema,
  })
  .strict();

export const revisionArtifactManifestSchema = z
  .object({
    version: z.literal(1),
    projectId: z.uuid(),
    revisionId: z.uuid(),
    commitSha: gitShaSchema,
    attempt: z.number().int().positive().max(1_000),
    builderVersion: z.string().min(1).max(100),
    previewEntry: z.literal("index.html"),
    renderEntry: z.literal("render.html"),
    inputDigest: sha256Schema,
    files: z.array(revisionArtifactFileSchema).min(2).max(1_000),
    createdAt: isoTimestampSchema,
  })
  .strict();

export const revisionApprovalSummarySchema = z
  .object({
    approvedAt: isoTimestampSchema,
    manifestDigest: sha256Schema,
    inputDigest: sha256Schema,
    attempt: z.number().int().positive().max(1_000),
  })
  .strict();

export const managedRenderStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("queued"), id: z.uuid() }).strict(),
  z.object({ status: z.literal("rendering"), id: z.uuid() }).strict(),
  z
    .object({
      status: z.literal("ready"),
      id: z.uuid(),
      videoId: z.string().min(1).max(255),
      previewUrl: z.url(),
      hlsUrl: z.url(),
      thumbnailUrl: z.url(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      id: z.uuid(),
      error: z.string().min(1).max(1_000),
    })
    .strict(),
]);

export const previewSessionSchema = z
  .object({ url: z.url(), expiresAt: isoTimestampSchema })
  .strict();

export const sourceProvenanceSchema = z
  .object({
    revisionId: z.uuid(),
    commitSha: gitShaSchema,
    markdown: z
      .string()
      .min(1)
      .max(64 * 1024)
      .refine((value) => value.trim().length > 0, {
        message: "Source provenance must not be blank",
      })
      .refine(isCompleteSourceProvenance, {
        message: "Source provenance must complete every required section",
      }),
  })
  .strict();

function isCompleteSourceProvenance(markdown: string): boolean {
  const normalized = markdown.replaceAll("\r\n", "\n");
  const productSource = sourceProvenanceSection(
    normalized,
    "## Product Source",
  );
  const reusedSource = sourceProvenanceSection(normalized, "## Reused Source");
  const adaptations = sourceProvenanceSection(normalized, "## Adaptations");
  const differences = sourceProvenanceSection(
    normalized,
    "## Remaining Visual Differences",
  );
  if (
    productSource === undefined ||
    reusedSource === undefined ||
    adaptations === undefined ||
    differences === undefined
  ) {
    return false;
  }
  if (!/^- Commit:\s*(?:[0-9a-f]{40}|`[0-9a-f]{40}`)\s*$/im.test(productSource))
    return false;
  if (!hasCompletedField(productSource, "Repository")) return false;
  for (const field of ["Components", "Styles and fonts", "Icons and assets"]) {
    if (!hasCompletedField(reusedSource, field)) return false;
  }
  return [adaptations, differences].every(sectionHasCompletedBullet);
}

function sourceProvenanceSection(
  markdown: string,
  heading: string,
): string | undefined {
  const headingStart = markdown.indexOf(heading);
  if (headingStart === -1) return undefined;
  const sectionStart = headingStart + heading.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  return markdown.slice(
    sectionStart,
    nextSection === -1 ? undefined : nextSection,
  );
}

function hasCompletedField(section: string, field: string): boolean {
  const value = section.match(new RegExp(`^- ${field}:\\s*(.+)$`, "m"))?.[1];
  return value !== undefined && !isPlaceholder(value);
}

function sectionHasCompletedBullet(section: string): boolean {
  return section
    .split("\n")
    .some((line) => line.startsWith("- ") && !isPlaceholder(line.slice(2)));
}

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed === "" ||
    (trimmed.startsWith("<") && trimmed.endsWith(">")) ||
    /^(?:tbd|todo|unknown|placeholder|pending|not yet)(?:\b|$)/i.test(trimmed)
  );
}

export const managedContainerRenderRequestSchema = z
  .object({
    kind: z.literal("managed-revision"),
    jobId: z.uuid(),
    manifest: revisionArtifactManifestSchema,
    manifestDigest: sha256Schema,
    artifactUrl: z.url(),
    artifactToken: z.string().min(32).max(4_096),
    finishingSpec: finishingSpecSchema,
    audioCapability: z
      .object({
        url: z.url(),
        token: z.string().min(32).max(4_096),
        sha256: sha256Schema,
        byteSize: z
          .number()
          .int()
          .positive()
          .max(25 * 1024 * 1024),
      })
      .strict()
      .optional(),
    streamUpload: z
      .object({
        videoId: z.string().min(1).max(255),
        uploadUrl: z.url(),
      })
      .strict(),
  })
  .strict();

export const projectRevisionSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    commitSha: gitShaSchema,
    ref: gitBranchRefSchema,
    isDefaultBranch: z.boolean(),
    inspectionVersion: z.number().int().positive().max(1_000),
    status: revisionInspectionStatusSchema,
    findings: z.array(revisionFindingSchema).max(100),
    build: revisionBuildSummarySchema.nullable(),
    approval: revisionApprovalSummarySchema.nullable(),
    latestRender: managedRenderStatusSchema.nullable(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const projectRevisionListSchema = z
  .object({ revisions: z.array(projectRevisionSchema).max(1_000) })
  .strict();

export type RevisionBundleSubmission = z.infer<
  typeof revisionBundleSubmissionSchema
>;
export type RevisionBundleSubmissionResult = z.infer<
  typeof revisionBundleSubmissionResultSchema
>;
export type RevisionSubmissionWorkflowCommand = z.infer<
  typeof revisionSubmissionWorkflowCommandSchema
>;
export type ProjectRevision = z.infer<typeof projectRevisionSchema>;
export type RevisionFinding = z.infer<typeof revisionFindingSchema>;
export type RevisionInspectionStatus = z.infer<
  typeof revisionInspectionStatusSchema
>;
export type RevisionCheckName = z.infer<typeof revisionCheckNameSchema>;
export type RevisionCheckResult = z.infer<typeof revisionCheckResultSchema>;
export type RevisionBuildStatus = z.infer<typeof revisionBuildStatusSchema>;
export type RevisionArtifactFile = z.infer<typeof revisionArtifactFileSchema>;
export type RevisionArtifactManifest = z.infer<
  typeof revisionArtifactManifestSchema
>;
export type RevisionApprovalSummary = z.infer<
  typeof revisionApprovalSummarySchema
>;
export type ManagedRenderStatus = z.infer<typeof managedRenderStatusSchema>;
export type PreviewSession = z.infer<typeof previewSessionSchema>;
export type SourceProvenance = z.infer<typeof sourceProvenanceSchema>;
