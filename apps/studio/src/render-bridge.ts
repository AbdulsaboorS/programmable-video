import { videoSpec } from "@programmable-video/contracts";
import {
  getCompositionManifest,
  type CompositionId,
  type CompositionProps,
} from "@programmable-video/composition-registry";
import {
  getBrowserComposition,
  type CompositionRenderer,
} from "@programmable-video/composition-registry/browser";
import { createElement } from "react";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import type {
  FrameAcknowledgement,
  JsonValue,
  VideoRendererBridge,
} from "./types";

const buildId = import.meta.env.VITE_BUILD_ID || "development";

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function settleVisuals(requiredFonts: readonly string[]): Promise<void> {
  await document.fonts.ready;
  for (const font of requiredFonts) {
    if (!document.fonts.check(font)) {
      throw new Error(`Composition font failed to load: ${font}`);
    }
  }
  const images = Array.from(document.images);
  await Promise.all(
    images.map(async (image) => {
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

function verifyViewport(frame: number): FrameAcknowledgement {
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;

  if (width !== videoSpec.width || height !== videoSpec.height) {
    throw new Error(
      `Invalid render viewport ${width}x${height}; expected ${videoSpec.width}x${videoSpec.height}`,
    );
  }

  document.documentElement.dataset.renderedFrame = String(frame);
  return { buildId, frame, height, width };
}

function renderComposition<Id extends CompositionId>(
  root: Root,
  compositionId: Id,
  frame: number,
  props: CompositionProps,
): void {
  const browserComposition = getBrowserComposition(compositionId);
  const parsedProps = browserComposition.manifest.propsSchema.parse(props);
  // SAFETY: The browser registry pairs each renderer with the manifest that parsed these props.
  const Renderer = browserComposition.Renderer as CompositionRenderer<
    typeof parsedProps
  >;
  root.render(
    createElement(Renderer, {
      frame,
      props: parsedProps,
    }),
  );
}

export function installRenderBridge(root: Root): VideoRendererBridge {
  let currentCompositionId: CompositionId | undefined;
  let currentProps: CompositionProps | undefined;

  const renderFrame = async (
    frame: number,
    props?: JsonValue,
  ): Promise<FrameAcknowledgement> => {
    if (
      !Number.isInteger(frame) ||
      frame < 0 ||
      frame >= videoSpec.durationInFrames
    ) {
      throw new RangeError(
        `Frame must be an integer from 0 to ${videoSpec.durationInFrames - 1}`,
      );
    }

    if (props !== undefined) {
      if (currentCompositionId === undefined) {
        throw new Error("Renderer must be initialized before updating props");
      }
      const manifest = getCompositionManifest(currentCompositionId);
      if (!manifest) throw new Error("Unknown current composition");
      currentProps = manifest.propsSchema.parse(props);
    }
    if (currentCompositionId === undefined || currentProps === undefined) {
      throw new Error("Renderer must be initialized before rendering a frame");
    }
    const renderProps = currentProps;
    const compositionId = currentCompositionId;
    const browserComposition = getBrowserComposition(compositionId);

    flushSync(() => {
      renderComposition(root, compositionId, frame, renderProps);
    });
    await settleVisuals(browserComposition.requiredFonts);
    return verifyViewport(frame);
  };

  const bridge: VideoRendererBridge = {
    version: "1",
    spec: videoSpec,
    buildId,
    initialize: async (compositionId, props) => {
      const manifest = getCompositionManifest(compositionId);
      if (manifest === undefined) {
        throw new Error(`Unknown composition: ${compositionId}`);
      }
      currentCompositionId = manifest.id;
      currentProps = manifest.propsSchema.parse(props);
      return renderFrame(0);
    },
    renderFrame,
  };

  window.__VIDEO_RENDERER__ = bridge;
  window.dispatchEvent(new Event("video-renderer-ready"));
  return bridge;
}
