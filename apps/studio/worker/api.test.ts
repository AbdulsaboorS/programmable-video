import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { compositionManifests } from "@programmable-video/composition-registry";
import { describe, expect, it, vi } from "vitest";

import { createRender, getRender, type RenderApiEnv } from "./api";
import { mapWorkflowStatus } from "./status";

const buildId = "test-build";
const manifest = compositionManifests[0];

type RenderRequestBody = {
  compositionId?: string;
  props?: object;
  buildId?: string;
};

interface TestWorkflowStatus {
  status: string;
  error?: { name?: string; message: string | number };
  output?: {
    status: string;
    videoId: string;
    previewUrl: string;
    hlsUrl: string;
    thumbnailUrl: string;
  };
}

function request(body: RenderRequestBody): Request {
  return new Request("https://studio.example/api/renders", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function environment(
  status: TestWorkflowStatus = { status: "queued" },
): RenderApiEnv {
  return fromPartial<RenderApiEnv>({
    BUILD_ID: buildId,
    RENDER_WORKFLOW: {
      create: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ status: async () => status })),
    },
  });
}

describe("render API", () => {
  it("returns 202 and propagates the validated request", async () => {
    const env = environment();
    const response = await createRender(
      request({
        compositionId: manifest.id,
        props: manifest.defaultProps,
        buildId,
      }),
      env,
    );

    expect(response.status).toBe(202);
    expect(env.RENDER_WORKFLOW.create).toHaveBeenCalledWith({
      id: expect.any(String),
      params: {
        compositionId: manifest.id,
        props: manifest.defaultProps,
        buildId,
      },
    });
  });

  it.each([
    { compositionId: "unknown", props: manifest.defaultProps, buildId },
    fromAny<
      RenderRequestBody,
      { compositionId: string; props: { other: string }; buildId: string }
    >({
      compositionId: manifest.id,
      props: { other: "wrong" },
      buildId,
    }),
    { compositionId: manifest.id, props: manifest.defaultProps },
  ])("returns 400 for invalid input", async (body) => {
    expect((await createRender(request(body), environment())).status).toBe(400);
  });

  it("returns 409 for a build mismatch", async () => {
    const response = await createRender(
      request({
        compositionId: manifest.id,
        props: manifest.defaultProps,
        buildId: "stale-build",
      }),
      environment(),
    );
    expect(response.status).toBe(409);
  });

  it("returns 404 for an unknown render", async () => {
    const env = environment();
    env.RENDER_WORKFLOW.get = vi.fn(async () => {
      throw new Error("missing");
    });
    expect((await getRender("not-a-uuid", env, mapWorkflowStatus)).status).toBe(
      404,
    );
    expect(
      (
        await getRender(
          "0198c7d4-a5e6-7000-8000-000000000000",
          env,
          mapWorkflowStatus,
        )
      ).status,
    ).toBe(404);
  });

  it.each([
    [{ status: "queued" }, { status: "queued" }],
    [
      {
        status: "errored",
        error: { name: "Error", message: "[upload] Stream unavailable" },
      },
      {
        status: "failed",
        error: { stage: "upload", message: "Stream unavailable" },
      },
    ],
    [
      {
        status: "complete",
        output: {
          status: "ready",
          videoId: "video-id",
          previewUrl: "https://example.com/watch",
          hlsUrl: "https://example.com/video.m3u8",
          thumbnailUrl: "https://example.com/thumbnail.jpg",
        },
      },
      {
        status: "ready",
        videoId: "video-id",
        previewUrl: "https://example.com/watch",
        hlsUrl: "https://example.com/video.m3u8",
        thumbnailUrl: "https://example.com/thumbnail.jpg",
      },
    ],
    [
      { status: "invalid", error: { message: 42 } },
      {
        status: "failed",
        error: { stage: "render", message: "Render failed" },
      },
    ],
  ])(
    "parses and maps workflow status through getRender",
    async (workflowStatus, expected) => {
      const response = await getRender(
        "0198c7d4-a5e6-7000-8000-000000000000",
        environment(workflowStatus),
        mapWorkflowStatus,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
    },
  );
});
