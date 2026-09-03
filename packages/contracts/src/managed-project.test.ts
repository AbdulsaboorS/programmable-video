import { describe, expect, it } from "vitest";

import {
  agentHandoffSchema,
  createManagedProjectRequestSchema,
  createProjectFeedbackRequestSchema,
  createReferenceUploadRequestSchema,
  managedRepositorySchema,
  referenceImageMaxBytes,
  referenceMetadataSchema,
  saveProjectBriefRequestSchema,
} from "./managed-project";

describe("managed project contracts", () => {
  it("normalizes a strict GitHub project request", () => {
    expect(
      createManagedProjectRequestSchema.parse({
        requestId: "0198c7d4-a5e6-7000-8000-000000000000",
        name: "  Product demo  ",
        githubUrl: "https://github.com/team/product",
      }),
    ).toEqual({
      requestId: "0198c7d4-a5e6-7000-8000-000000000000",
      name: "Product demo",
      githubUrl: "https://github.com/team/product",
      defaultBranch: "main",
    });
  });

  it("rejects non-HTTPS sources and unknown keys", () => {
    expect(
      createManagedProjectRequestSchema.safeParse({
        requestId: "0198c7d4-a5e6-7000-8000-000000000000",
        name: "Product",
        githubUrl: "http://github.com/team/product",
      }).success,
    ).toBe(false);
    expect(
      createManagedProjectRequestSchema.safeParse({
        requestId: "0198c7d4-a5e6-7000-8000-000000000000",
        name: "Product",
        githubUrl: "https://github.com/team/product",
        defaultBranch: "main\noverride",
      }).success,
    ).toBe(false);
    expect(
      createManagedProjectRequestSchema.safeParse({
        requestId: "0198c7d4-a5e6-7000-8000-000000000000",
        name: "Product",
        githubUrl: "https://github.com/team/product",
        token: "secret",
      }).success,
    ).toBe(false);
  });

  it("bounds and normalizes the represented state", () => {
    expect(
      createReferenceUploadRequestSchema.parse({
        representedState: "  Authenticated dashboard  ",
      }),
    ).toEqual({ representedState: "Authenticated dashboard" });
    expect(
      createReferenceUploadRequestSchema.safeParse({ representedState: "" })
        .success,
    ).toBe(false);
  });

  it("accepts legacy and uploaded reference records", () => {
    const base = {
      id: "0198c7d4-a5e6-7000-8000-000000000010",
      fileName: "product.png",
      mediaType: "image/png",
      byteSize: referenceImageMaxBytes,
      note: "Authenticated dashboard",
      createdAt: "2026-08-24T12:00:00.000Z",
    };
    expect(
      referenceMetadataSchema.parse({ ...base, storageState: "metadata-only" }),
    ).toEqual({ ...base, storageState: "metadata-only" });
    expect(
      referenceMetadataSchema.safeParse({
        ...base,
        byteSize: 25 * 1024 * 1024,
        storageState: "metadata-only",
      }).success,
    ).toBe(true);
    expect(
      referenceMetadataSchema.parse({
        ...base,
        storageState: "uploaded",
        width: 1280,
        height: 720,
      }),
    ).toEqual({
      ...base,
      storageState: "uploaded",
      width: 1280,
      height: 720,
    });
    expect(
      referenceMetadataSchema.safeParse({
        ...base,
        storageState: "uploaded",
        width: 4097,
        height: 720,
      }).success,
    ).toBe(false);
    expect(
      referenceMetadataSchema.safeParse({
        ...base,
        storageState: "uploaded",
        width: 4096,
        height: 4096,
      }).success,
    ).toBe(false);
  });

  it("requires secure reference downloads in agent handoffs", () => {
    const handoff = {
      kind: "artifacts",
      remoteUrl: "https://artifacts.example/video.git",
      token: "git-token",
      tokenExpiresAt: "2026-08-20T11:00:00.000Z",
      defaultBranch: "main",
      references: [
        {
          id: "0198c7d4-a5e6-7000-8000-000000000010",
          fileName: "product.png",
          downloadUrl:
            "https://studio.example/api/internal/project-references/0198c7d4-a5e6-7000-8000-000000000010",
          token: "reference-token",
          sha256: "a".repeat(64),
        },
      ],
    };
    expect(agentHandoffSchema.parse(handoff)).toEqual(handoff);
    expect(
      agentHandoffSchema.safeParse({
        ...handoff,
        references: [
          {
            ...handoff.references[0],
            downloadUrl: "http://studio.example/ref",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("distinguishes artifacts and local authoring contracts", () => {
    expect(
      managedRepositorySchema.safeParse({
        kind: "artifacts",
        name: "project-video",
        remoteUrl: "https://artifacts.example/video.git",
        defaultBranch: "main",
        state: "seeded",
      }).success,
    ).toBe(true);
    expect(
      managedRepositorySchema.safeParse({
        kind: "local",
        defaultBranch: "main",
        state: "initialized",
      }).success,
    ).toBe(true);

    const localHandoff = {
      kind: "local",
      projectId: "0198c7d4-a5e6-7000-8000-000000000000",
      defaultBranch: "main",
      tokenExpiresAt: "2026-08-20T11:00:00.000Z",
      references: [],
    };
    expect(agentHandoffSchema.parse(localHandoff)).toEqual(localHandoff);
    expect(
      agentHandoffSchema.safeParse({
        ...localHandoff,
        remoteUrl: "https://artifacts.example/video.git",
      }).success,
    ).toBe(false);
  });

  it("normalizes bounded briefs and frame-specific feedback", () => {
    expect(
      saveProjectBriefRequestSchema.parse({ text: "  Show the launch.  " }),
    ).toEqual({ text: "Show the launch." });
    expect(
      createProjectFeedbackRequestSchema.parse({
        id: "0198c7d4-a5e6-7000-8000-000000000002",
        revisionId: "0198c7d4-a5e6-7000-8000-000000000003",
        frame: 123,
        fps: 30,
        durationInFrames: 360,
        text: "  Match the source orb.  ",
      }),
    ).toEqual({
      id: "0198c7d4-a5e6-7000-8000-000000000002",
      revisionId: "0198c7d4-a5e6-7000-8000-000000000003",
      frame: 123,
      fps: 30,
      durationInFrames: 360,
      text: "Match the source orb.",
    });
  });

  it("rejects invalid persisted review data", () => {
    expect(saveProjectBriefRequestSchema.safeParse({ text: "" }).success).toBe(
      false,
    );
    expect(
      createProjectFeedbackRequestSchema.safeParse({
        id: "0198c7d4-a5e6-7000-8000-000000000002",
        revisionId: "0198c7d4-a5e6-7000-8000-000000000003",
        frame: -1,
        fps: 0,
        durationInFrames: 360,
        text: "Change it",
      }).success,
    ).toBe(false);
    expect(
      createProjectFeedbackRequestSchema.safeParse({
        id: "0198c7d4-a5e6-7000-8000-000000000002",
        revisionId: "0198c7d4-a5e6-7000-8000-000000000003",
        frame: 360,
        fps: 30,
        durationInFrames: 360,
        text: "Change it",
      }).success,
    ).toBe(false);
  });
});
