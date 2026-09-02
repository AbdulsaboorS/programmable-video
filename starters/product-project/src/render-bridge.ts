import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { ProductComposition } from "./ProductComposition";
import { defaultStory, videoSpec } from "./story";
import { productFrame } from "./timeline";

export const bridgeVersion = 1 as const;

function buildValue(read: () => string, fallback: string): string {
  try {
    return read();
  } catch (error) {
    if (error instanceof ReferenceError) return fallback;
    throw error;
  }
}

export const buildIdentity = {
  commitSha: buildValue(() => __VIDEO_COMMIT_SHA__, "placeholder-commit-sha"),
  buildAttempt: buildValue(
    () => __VIDEO_BUILD_ATTEMPT__,
    "placeholder-build-attempt",
  ),
  inputDigest: buildValue(
    () => __VIDEO_INPUT_DIGEST__,
    "placeholder-input-digest",
  ),
} as const;

export interface FrameAcknowledgement {
  bridgeVersion: typeof bridgeVersion;
  buildIdentity: typeof buildIdentity;
  frame: number;
  height: number;
  width: number;
}

export interface VideoRendererBridge {
  bridgeVersion: typeof bridgeVersion;
  buildIdentity: typeof buildIdentity;
  renderFrame(frame: number): Promise<FrameAcknowledgement>;
  spec: typeof videoSpec;
}

export interface RenderRoot {
  render(children: ReactNode): void;
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function settleVisuals(): Promise<void> {
  await document.fonts.ready;
  await Promise.all(
    Array.from(document.images).map(async (image) => {
      if (!image.complete) {
        await new Promise<void>((resolve) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        });
      }
      if (!image.complete || image.naturalWidth === 0) {
        throw new Error(
          `Composition image failed to load: ${image.currentSrc}`,
        );
      }
      await image.decode();
    }),
  );
  await nextPaint();
  await nextPaint();
}

export function normalizeRenderFrame(frame: number): number {
  if (!Number.isInteger(frame)) {
    throw new RangeError("Frame must be an integer");
  }
  return productFrame(frame).frame;
}

function acknowledgeFrame(frame: number): FrameAcknowledgement {
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;
  const composition = document.querySelector(".pv-composition");
  const bounds = composition?.getBoundingClientRect();

  if (
    width !== videoSpec.width ||
    height !== videoSpec.height ||
    bounds?.width !== videoSpec.width ||
    bounds.height !== videoSpec.height
  ) {
    throw new Error(
      `Invalid render dimensions ${width}x${height}; expected ${videoSpec.width}x${videoSpec.height}`,
    );
  }

  document.documentElement.dataset.renderedFrame = String(frame);
  return {
    bridgeVersion,
    buildIdentity,
    frame,
    height,
    width,
  };
}

export function createRenderBridge(root: RenderRoot): VideoRendererBridge {
  return {
    bridgeVersion,
    buildIdentity,
    spec: videoSpec,
    renderFrame: async (requestedFrame) => {
      const frame = normalizeRenderFrame(requestedFrame);
      flushSync(() => {
        root.render(
          createElement(ProductComposition, { frame, story: defaultStory }),
        );
      });
      await settleVisuals();
      return acknowledgeFrame(frame);
    },
  };
}

export function installRenderBridge(root: RenderRoot): VideoRendererBridge {
  const bridge = createRenderBridge(root);
  window.__VIDEO_RENDERER__ = bridge;
  window.dispatchEvent(new Event("video-renderer-ready"));
  return bridge;
}
