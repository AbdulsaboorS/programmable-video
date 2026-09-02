// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  finishingContainBackground,
  finishingSpecVersion,
  type PreviewSession,
} from "@programmable-video/contracts";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FinishedOutputPreview,
  type FinishedOutputPreviewOperations,
} from "./FinishedOutputPreview";
import { previewReviewSource, reviewProtocolVersion } from "./review-protocol";

const createPreviewSession =
  vi.fn<FinishedOutputPreviewOperations["createPreviewSession"]>();
const operations: FinishedOutputPreviewOperations = { createPreviewSession };
let previewWindow: Window;

const finishingSpec = {
  version: finishingSpecVersion,
  trim: { startFrame: 12, endFrame: 300 },
  output: {
    profile: "portrait" as const,
    width: 1080 as const,
    height: 1920 as const,
    fit: "cover" as const,
    containBackground: finishingContainBackground,
  },
  audio: null,
  captions: { mode: "none" as const },
};

beforeEach(() => {
  window.happyDOM.settings.disableIframePageLoading = true;
  window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;
  previewWindow = fromPartial<Window>({ postMessage: vi.fn() });
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tagName, options) => {
    const element = createElement(tagName, options);
    if (element instanceof HTMLIFrameElement) {
      element.srcdoc = "";
      Object.defineProperty(element, "contentWindow", {
        configurable: true,
        value: previewWindow,
      });
    }
    return element;
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("FinishedOutputPreview", () => {
  it("reports protocol readiness and exposes exact trim context", async () => {
    createPreviewSession.mockResolvedValue({
      url: "https://preview.example/launch?token=signed",
      expiresAt: "2026-08-26T12:05:00.000Z",
    });
    const onStatusChange = vi.fn();
    const view = render(
      <FinishedOutputPreview
        projectId="0198c7d4-a5e6-7000-8000-000000000000"
        revisionId="0198c7d4-a5e6-7000-8000-000000000103"
        commitSha={`a${"b".repeat(39)}`}
        finishingSpec={finishingSpec}
        onStatusChange={onStatusChange}
        operations={operations}
      />,
    );

    const iframe = await screen.findByTitle("Finished-output preview abbbbbbb");
    if (!(iframe instanceof HTMLIFrameElement)) {
      throw new Error("Expected the finished-output preview iframe");
    }
    await waitFor(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://preview.example",
          source: iframe.contentWindow,
          data: {
            source: previewReviewSource,
            version: reviewProtocolVersion,
            type: "state",
            acknowledgedCommandId: 1,
            frame: 12,
            playing: false,
            spec: {
              width: 1280,
              height: 720,
              fps: 30,
              durationInFrames: 360,
            },
          },
        }),
      );
      expect(onStatusChange).toHaveBeenCalledWith("ready");
    });
    expect(
      screen.getByText(/this preview checks picture, crop, and trim/),
    ).toBeDefined();
    const play = screen.getByRole("button", { name: "Play" });
    expect(play.hasAttribute("disabled")).toBe(false);
    const position = screen.getByLabelText("Finished video position");
    expect(position.getAttribute("min")).toBe("12");
    expect(position.getAttribute("max")).toBe("299");
    play.click();
    expect(previewWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "play" }),
      "https://preview.example",
    );
    view.rerender(
      <FinishedOutputPreview
        projectId="0198c7d4-a5e6-7000-8000-000000000000"
        revisionId="0198c7d4-a5e6-7000-8000-000000000103"
        commitSha={`a${"b".repeat(39)}`}
        finishingSpec={{
          ...finishingSpec,
          trim: { startFrame: 100, endFrame: 300 },
        }}
        onStatusChange={onStatusChange}
        operations={operations}
      />,
    );
    await waitFor(() =>
      expect(previewWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "seek", frame: 100 }),
        "https://preview.example",
      ),
    );
    vi.mocked(previewWindow.postMessage).mockClear();
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://preview.example",
        source: iframe.contentWindow,
        data: {
          source: previewReviewSource,
          version: reviewProtocolVersion,
          type: "state",
          acknowledgedCommandId: 4,
          frame: 310,
          playing: true,
          spec: {
            width: 1280,
            height: 720,
            fps: 30,
            durationInFrames: 360,
          },
        },
      }),
    );
    await waitFor(() => {
      expect(previewWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "pause" }),
        "https://preview.example",
      );
      expect(previewWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "seek", frame: 299 }),
        "https://preview.example",
      );
    });
    expect(iframe.getAttribute("allow")).toBe("fullscreen");
    expect(iframe.hasAttribute("allowfullscreen")).toBe(true);
  });

  it("reports session errors to its parent", async () => {
    createPreviewSession.mockRejectedValue(new Error("Preview unavailable"));
    const onStatusChange = vi.fn();
    render(
      <FinishedOutputPreview
        projectId="0198c7d4-a5e6-7000-8000-000000000000"
        revisionId="0198c7d4-a5e6-7000-8000-000000000103"
        commitSha={`a${"b".repeat(39)}`}
        finishingSpec={finishingSpec}
        onStatusChange={onStatusChange}
        operations={operations}
      />,
    );

    expect(await screen.findByText("Preview unavailable")).toBeDefined();
    expect(onStatusChange).toHaveBeenCalledWith("error");
  });

  it("uses a replaced preview-session operation and fences the stale request", async () => {
    let resolveStale: (session: PreviewSession) => void = () => undefined;
    const firstCreate = vi.fn<
      FinishedOutputPreviewOperations["createPreviewSession"]
    >(
      () =>
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
    );
    const nextCreate = vi
      .fn<FinishedOutputPreviewOperations["createPreviewSession"]>()
      .mockResolvedValue({
        url: "https://preview.example/current?token=signed",
        expiresAt: "2026-08-26T12:05:00.000Z",
      });
    const onStatusChange = vi.fn();
    const view = render(
      <FinishedOutputPreview
        projectId="0198c7d4-a5e6-7000-8000-000000000000"
        revisionId="0198c7d4-a5e6-7000-8000-000000000103"
        commitSha={`a${"b".repeat(39)}`}
        finishingSpec={finishingSpec}
        onStatusChange={onStatusChange}
        operations={{ createPreviewSession: firstCreate }}
      />,
    );

    view.rerender(
      <FinishedOutputPreview
        projectId="0198c7d4-a5e6-7000-8000-000000000000"
        revisionId="0198c7d4-a5e6-7000-8000-000000000103"
        commitSha={`a${"b".repeat(39)}`}
        finishingSpec={finishingSpec}
        onStatusChange={onStatusChange}
        operations={{ createPreviewSession: nextCreate }}
      />,
    );

    const iframe = await screen.findByTitle("Finished-output preview abbbbbbb");
    expect(iframe.getAttribute("src")).toContain("/current?");
    resolveStale({
      url: "https://preview.example/stale?token=signed",
      expiresAt: "2026-08-26T12:05:00.000Z",
    });
    await Promise.resolve();
    expect(iframe.getAttribute("src")).toContain("/current?");
  });

  it("uses the production preview-session operation by default", async () => {
    const fetchRequest = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          url: "https://preview.example/default?token=signed",
          expiresAt: "2026-08-26T12:05:00.000Z",
        }),
        { status: 200 },
      ),
    );

    render(
      <FinishedOutputPreview
        projectId="0198c7d4-a5e6-7000-8000-000000000000"
        revisionId="0198c7d4-a5e6-7000-8000-000000000103"
        commitSha={`a${"b".repeat(39)}`}
        finishingSpec={finishingSpec}
        onStatusChange={vi.fn()}
      />,
    );

    const iframe = await screen.findByTitle("Finished-output preview abbbbbbb");
    expect(iframe.getAttribute("src")).toContain("/default?");
    expect(fetchRequest).toHaveBeenCalledWith(
      "/api/projects/0198c7d4-a5e6-7000-8000-000000000000/revisions/0198c7d4-a5e6-7000-8000-000000000103/preview-session",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
