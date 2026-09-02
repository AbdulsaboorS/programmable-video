import { compositionManifests } from "@programmable-video/composition-registry";
import { getBrowserComposition } from "@programmable-video/composition-registry/browser";
import { fromPartial } from "@total-typescript/shoehorn";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installRenderBridge } from "./render-bridge";

function captureRoot(onRender: (element: ReactElement) => void): Root {
  return fromPartial<Root>({
    render(node: ReactNode) {
      if (!isValidElement(node)) throw new Error("Expected a React element");
      onRender(node);
    },
  });
}

const emptyRoot = () => captureRoot(() => undefined);

describe("browser render bridge", () => {
  beforeEach(() => {
    const eventTarget = new EventTarget();
    Object.assign(globalThis, {
      document: {
        fonts: { ready: Promise.resolve(), check: () => true },
        images: [],
        documentElement: {
          clientWidth: 1280,
          clientHeight: 720,
          dataset: {},
        },
      },
      window: eventTarget,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });
  });

  it.each(compositionManifests)(
    "initializes and renders registered composition $id",
    async (manifest) => {
      let element: ReactElement | undefined;
      const root = captureRoot((nextElement) => {
        element = nextElement;
      });
      const bridge = installRenderBridge(root);

      await expect(
        bridge.initialize(manifest.id, manifest.defaultProps),
      ).resolves.toMatchObject({ frame: 0, width: 1280, height: 720 });
      expect(element?.type).toBe(getBrowserComposition(manifest.id).Renderer);
      expect(element?.props).toEqual({
        frame: 0,
        props: manifest.defaultProps,
      });

      await expect(bridge.renderFrame(220)).resolves.toMatchObject({
        frame: 220,
      });
      expect(element?.props).toEqual({
        frame: 220,
        props: manifest.defaultProps,
      });
    },
  );

  it("rejects rendering before initialization", async () => {
    const bridge = installRenderBridge(emptyRoot());

    await expect(bridge.renderFrame(0)).rejects.toThrow(
      "Renderer must be initialized before rendering a frame",
    );
  });

  it("keeps initialization state isolated between bridge instances", async () => {
    const initializedBridge = installRenderBridge(emptyRoot());
    const uninitializedBridge = installRenderBridge(emptyRoot());

    await initializedBridge.initialize(
      compositionManifests[0].id,
      compositionManifests[0].defaultProps,
    );
    await expect(uninitializedBridge.renderFrame(0)).rejects.toThrow(
      "Renderer must be initialized before rendering a frame",
    );
  });

  it("rejects unknown compositions and mismatched props", async () => {
    const bridge = installRenderBridge(emptyRoot());

    await expect(
      bridge.initialize("unknown", compositionManifests[0].defaultProps),
    ).rejects.toThrow("Unknown composition");
    await expect(
      bridge.initialize("support-agent", { headline: "wrong schema" }),
    ).rejects.toThrow();
  });

  it("rejects rendering when a required font is unavailable", async () => {
    Object.defineProperty(document.fonts, "check", {
      configurable: true,
      value: vi.fn(() => false),
    });
    const bridge = installRenderBridge(emptyRoot());

    await expect(
      bridge.initialize("support-agent", compositionManifests[0].defaultProps),
    ).rejects.toThrow("Composition font failed to load");
  });
});
