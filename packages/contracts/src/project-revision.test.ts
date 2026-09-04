import { describe, expect, it } from "vitest";

import { createNoOpFinishingSpec } from "./finishing";
import {
  managedContainerRenderRequestSchema,
  projectRevisionListSchema,
  projectRevisionSchema,
  revisionFindingSchema,
  revisionBundleMaxBytes,
  revisionBundleSubmissionResultSchema,
  revisionBundleSubmissionSchema,
  revisionInspectionStatusSchema,
  revisionSubmissionWorkflowCommandSchema,
  sourceProvenanceSchema,
} from "./project-revision";

const lowerSha = "0123456789abcdef0123456789abcdef01234567";
const upperSha = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";

const revision = {
  id: "0198c7d4-a5e6-7000-8000-000000000001",
  projectId: "0198c7d4-a5e6-7000-8000-000000000000",
  commitSha: upperSha,
  ref: "refs/heads/main",
  isDefaultBranch: true,
  inspectionVersion: 1,
  status: "invalid",
  findings: [
    {
      severity: "error",
      code: "manifest.missing",
      message: "Composition manifest is missing.",
      path: "src/composition.tsx",
      line: 12,
      column: 3,
    },
  ],
  build: null,
  approval: null,
  latestRender: null,
  createdAt: "2026-08-20T12:00:01.000Z",
  updatedAt: "2026-08-20T12:00:02.000Z",
} as const;

const managedRenderRequest = {
  kind: "managed-revision",
  jobId: "0198c7d4-a5e6-7000-8000-000000000010",
  manifest: {
    version: 1,
    projectId: revision.projectId,
    revisionId: revision.id,
    commitSha: lowerSha,
    attempt: 1,
    builderVersion: "test",
    previewEntry: "index.html",
    renderEntry: "render.html",
    inputDigest: "a".repeat(64),
    files: [
      {
        path: "index.html",
        size: 1,
        mediaType: "text/html",
        digest: "b".repeat(64),
      },
      {
        path: "render.html",
        size: 1,
        mediaType: "text/html",
        digest: "c".repeat(64),
      },
    ],
    createdAt: "2026-08-20T12:00:00.000Z",
  },
  manifestDigest: "d".repeat(64),
  artifactUrl: "https://artifact.example.test/capability",
  artifactToken: "a".repeat(32),
  finishingSpec: createNoOpFinishingSpec(360),
  streamUpload: {
    videoId: "stream-video",
    uploadUrl: "https://upload.example.test/video",
  },
} as const;

describe("managed renderer request contract", () => {
  it("accepts an immutable finishing snapshot and private audio capability", () => {
    expect(
      managedContainerRenderRequestSchema.safeParse({
        ...managedRenderRequest,
        finishingSpec: {
          ...createNoOpFinishingSpec(360),
          audio: {
            asset: {
              id: "0198c7d4-a5e6-7000-8000-000000000011",
              sha256: "e".repeat(64),
            },
            gainPercent: 50,
          },
        },
        audioCapability: {
          url: "https://media.example.test/capability",
          token: "t".repeat(32),
          sha256: "e".repeat(64),
          byteSize: 1024,
        },
      }).success,
    ).toBe(true);
  });

  it("requires an immutable finishing snapshot", () => {
    const { finishingSpec: _finishingSpec, ...withoutFinishing } =
      managedRenderRequest;
    expect(
      managedContainerRenderRequestSchema.safeParse(withoutFinishing).success,
    ).toBe(false);
    expect(
      managedContainerRenderRequestSchema.safeParse({
        ...managedRenderRequest,
        finishingSpec: { version: 1 },
      }).success,
    ).toBe(false);
  });

  it("rejects oversized or extensible media capabilities", () => {
    expect(
      managedContainerRenderRequestSchema.safeParse({
        ...managedRenderRequest,
        audioCapability: {
          url: "https://media.example.test/capability",
          token: "t".repeat(32),
          sha256: "e".repeat(64),
          byteSize: 25 * 1024 * 1024 + 1,
        },
      }).success,
    ).toBe(false);
    expect(
      managedContainerRenderRequestSchema.safeParse({
        ...managedRenderRequest,
        audioCapability: {
          url: "https://media.example.test/capability",
          token: "t".repeat(32),
          sha256: "e".repeat(64),
          byteSize: 1024,
          browserUrl: "https://public.example.test/audio",
        },
      }).success,
    ).toBe(false);
  });
});

describe("local revision bundle contracts", () => {
  const submission = {
    commitSha: lowerSha,
    ref: "refs/heads/main",
    bundleSha256: "a".repeat(64),
    bundleSize: revisionBundleMaxBytes,
  };

  it("accepts strict bounded bundle submissions", () => {
    expect(revisionBundleSubmissionSchema.parse(submission)).toEqual(
      submission,
    );
    expect(
      revisionBundleSubmissionSchema.safeParse({
        ...submission,
        bundleSize: revisionBundleMaxBytes + 1,
      }).success,
    ).toBe(false);
    expect(
      revisionBundleSubmissionSchema.safeParse({ ...submission, extra: true })
        .success,
    ).toBe(false);
  });

  it.each([
    "0123456789abcdef0123456789abcdef0123456",
    "0123456789abcdef0123456789abcdef012345678",
    "g123456789abcdef0123456789abcdef01234567",
  ])("rejects invalid 40-character hex SHA %s", (commitSha) => {
    expect(
      revisionBundleSubmissionSchema.safeParse({ ...submission, commitSha })
        .success,
    ).toBe(false);
  });

  it.each([
    "main",
    "refs/notes/ai",
    "refs/heads/feature..name",
    "refs/heads/release.lock",
    "refs/heads/has space",
  ])("rejects a non-branch or invalid Git ref %s", (ref) => {
    expect(
      revisionBundleSubmissionSchema.safeParse({ ...submission, ref }).success,
    ).toBe(false);
  });

  it("accepts submission results and workflow commands", () => {
    const revisionId = "0198c7d4-a5e6-7000-8000-000000000001";
    expect(
      revisionBundleSubmissionResultSchema.safeParse({
        revisionId,
        commitSha: lowerSha,
        status: "already-submitted",
      }).success,
    ).toBe(true);
    expect(
      revisionSubmissionWorkflowCommandSchema.safeParse({
        kind: "submitted-revision",
        projectId: "0198c7d4-a5e6-7000-8000-000000000000",
        revisionId,
      }).success,
    ).toBe(true);
  });
});

describe("source provenance contract", () => {
  const provenance = {
    revisionId: "0198c7d4-a5e6-7000-8000-000000000001",
    commitSha: lowerSha,
    markdown: `# Source Provenance

## Product Source

- Repository: https://gitlab.example.com/product
- Commit: ${lowerSha}

## Reused Source

- Components: src/Dashboard.tsx: Dashboard
- Styles and fonts: src/dashboard.css
- Icons and assets: src/icons/check.svg

## Adaptations

- Fixed demo data replaces API calls.

## Remaining Visual Differences

- None`,
  };

  it("accepts bounded exact-revision Markdown", () => {
    expect(sourceProvenanceSchema.parse(provenance)).toEqual(provenance);
  });

  it("accepts a source commit formatted as inline Markdown code", () => {
    expect(
      sourceProvenanceSchema.safeParse({
        ...provenance,
        markdown: provenance.markdown.replace(
          `- Commit: ${lowerSha}`,
          `- Commit: \`${lowerSha}\``,
        ),
      }).success,
    ).toBe(true);
  });

  it("rejects blank, trivial, incomplete, placeholder, oversized, and malformed evidence", () => {
    expect(
      sourceProvenanceSchema.safeParse({ ...provenance, markdown: "   " })
        .success,
    ).toBe(false);
    expect(
      sourceProvenanceSchema.safeParse({ ...provenance, markdown: "x" })
        .success,
    ).toBe(false);
    expect(
      sourceProvenanceSchema.safeParse({
        ...provenance,
        markdown: provenance.markdown.replace("## Adaptations", "## Changes"),
      }).success,
    ).toBe(false);
    expect(
      sourceProvenanceSchema.safeParse({
        ...provenance,
        markdown: provenance.markdown.replace(
          "src/dashboard.css",
          "TODO: identify styles",
        ),
      }).success,
    ).toBe(false);
    expect(
      sourceProvenanceSchema.safeParse({
        ...provenance,
        markdown: provenance.markdown.replace(
          "- Components: src/Dashboard.tsx: Dashboard",
          "- Components moved outside its section: src/Dashboard.tsx: Dashboard",
        ),
      }).success,
    ).toBe(false);
    expect(
      sourceProvenanceSchema.safeParse({
        ...provenance,
        markdown: provenance.markdown.replace(
          "src/Dashboard.tsx: Dashboard",
          "<paths and exported names>",
        ),
      }).success,
    ).toBe(false);
    expect(
      sourceProvenanceSchema.safeParse({
        ...provenance,
        markdown: "x".repeat(64 * 1024 + 1),
      }).success,
    ).toBe(false);
    expect(
      sourceProvenanceSchema.safeParse({
        ...provenance,
        revisionId: "not-a-revision",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("project revision contracts", () => {
  it.each(["pending", "valid", "invalid", "error"] as const)(
    "accepts the %s inspection status",
    (status) => {
      expect(
        projectRevisionSchema.safeParse({ ...revision, status }).success,
      ).toBe(true);
      expect(revisionInspectionStatusSchema.parse(status)).toBe(status);
    },
  );

  it("returns a bounded owner-visible list without ownership data", () => {
    expect(projectRevisionListSchema.parse({ revisions: [revision] })).toEqual({
      revisions: [revision],
    });
    expect(
      projectRevisionSchema.safeParse({
        ...revision,
        ownerEmail: "owner@example.com",
      }).success,
    ).toBe(false);
  });

  it("rejects malformed and oversized findings", () => {
    expect(
      revisionFindingSchema.safeParse({
        severity: "info",
        code: "manifest.missing",
        message: "Not actionable",
      }).success,
    ).toBe(false);
    expect(
      revisionFindingSchema.safeParse({
        severity: "error",
        code: "INVALID CODE",
        message: "Invalid code",
      }).success,
    ).toBe(false);
    expect(
      projectRevisionSchema.safeParse({
        ...revision,
        findings: Array.from({ length: 101 }, () => revision.findings[0]),
      }).success,
    ).toBe(false);
    expect(
      revisionFindingSchema.safeParse({
        ...revision.findings[0],
        rawOutput: "unbounded",
      }).success,
    ).toBe(false);
  });

  it("rejects invalid revision identity, versions, and timestamps", () => {
    expect(
      projectRevisionSchema.safeParse({
        ...revision,
        commitSha: lowerSha + "0",
      }).success,
    ).toBe(false);
    expect(
      projectRevisionSchema.safeParse({ ...revision, inspectionVersion: 0 })
        .success,
    ).toBe(false);
    expect(
      projectRevisionSchema.safeParse({ ...revision, createdAt: "yesterday" })
        .success,
    ).toBe(false);
  });
});
