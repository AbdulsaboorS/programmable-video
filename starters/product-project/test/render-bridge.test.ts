import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bridgeVersion,
  buildIdentity,
  createRenderBridge,
  normalizeRenderFrame,
} from "../src/render-bridge";
import { defaultStory, videoSpec } from "../src/story";

describe("render bridge", () => {
  let rendered: ReactNode;

  beforeEach(() => {
    rendered = undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("document", {
      documentElement: {
        clientHeight: videoSpec.height,
        clientWidth: videoSpec.width,
        dataset: {},
      },
      fonts: { ready: Promise.resolve() },
      images: [],
      querySelector: () => ({
        getBoundingClientRect: () => ({
          height: videoSpec.height,
          width: videoSpec.width,
        }),
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires integer frames and clamps them through the timeline", () => {
    expect(() => normalizeRenderFrame(1.5)).toThrow("integer");
    expect(normalizeRenderFrame(-1)).toBe(0);
    expect(normalizeRenderFrame(999)).toBe(359);
  });

  it("renders the bundled default story and acknowledges exact output", async () => {
    const root = {
      render(node: ReactNode) {
        rendered = node;
      },
    };
    const bridge = createRenderBridge(root);

    await expect(bridge.renderFrame(90)).resolves.toEqual({
      bridgeVersion: 1,
      buildIdentity,
      frame: 90,
      height: 720,
      width: 1280,
    });
    expect(bridge).toMatchObject({
      bridgeVersion,
      buildIdentity,
      spec: videoSpec,
    });
    expect(rendered).toMatchObject({
      props: { frame: 90, story: defaultStory },
    });
  });

  it("rejects a render viewport that is not 1280x720", async () => {
    Object.defineProperty(document.documentElement, "clientWidth", {
      value: 1279,
    });
    const bridge = createRenderBridge({ render: vi.fn() });

    await expect(bridge.renderFrame(0)).rejects.toThrow(
      "Invalid render dimensions 1279x720",
    );
  });

  it("exposes all build identity fields as build-defined strings", () => {
    expect(buildIdentity).toEqual({
      buildAttempt: expect.any(String),
      commitSha: expect.any(String),
      inputDigest: expect.any(String),
    });
  });
});
