// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatReviewTime,
  RevisionReviewCanvas,
  safePreviewOrigin,
} from "./RevisionReviewCanvas";
import {
  previewReviewSource,
  reviewCommand,
  reviewProtocolVersion,
  reviewStateFromMessage,
  studioReviewSource,
} from "./review-protocol";
import type { JsonValue } from "./types";

declare global {
  interface Window {
    happyDOM: {
      settings: {
        disableIframePageLoading: boolean;
        handleDisabledFileLoadingAsSuccess: boolean;
      };
    };
  }
}

const projectId = "0198c7d4-a5e6-7000-8000-000000000001";
const revisionId = "0198c7d4-a5e6-7000-8000-000000000002";
const previewOrigin = "https://preview.example";
let previewWindow: Window;

function previewState(
  frame: number,
  playing = false,
  acknowledgedCommandId = 0,
) {
  return {
    source: previewReviewSource,
    version: reviewProtocolVersion,
    type: "state",
    acknowledgedCommandId,
    frame,
    playing,
    spec: {
      width: 1280,
      height: 720,
      fps: 30,
      durationInFrames: 360,
    },
  };
}

function jsonResponse(value: JsonValue, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function previewIframe(title: string): Promise<HTMLIFrameElement> {
  const element = await screen.findByTitle(title);
  if (!(element instanceof HTMLIFrameElement)) {
    throw new Error(`Expected preview iframe: ${title}`);
  }
  return element;
}

function lastCommandId(postMessage: ReturnType<typeof vi.fn>): number {
  return z
    .object({ commandId: z.number().int().nonnegative() })
    .parse(postMessage.mock.calls.at(-1)?.[0]).commandId;
}

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("revision review canvas", () => {
  it("preserves the deployed review protocol identifiers", () => {
    expect(reviewProtocolVersion).toBe(1);
    expect(studioReviewSource).toBe("programmable-video-studio");
    expect(previewReviewSource).toBe("programmable-video-preview");
  });

  it("formats exact frame timestamps", () => {
    expect(formatReviewTime(0, 30)).toBe("00:00.000");
    expect(formatReviewTime(123, 30)).toBe("00:04.100");
    expect(formatReviewTime(1_815, 30)).toBe("01:00.500");
  });

  it("requires a distinct secure preview origin", () => {
    expect(
      safePreviewOrigin(
        "https://preview.example/launch",
        "https://studio.example",
      ),
    ).toBe("https://preview.example");
    expect(() =>
      safePreviewOrigin(
        "https://studio.example/launch",
        "https://studio.example",
      ),
    ).toThrow("separate secure origin");
    expect(() =>
      safePreviewOrigin(
        "http://preview.example/launch",
        "https://studio.example",
      ),
    ).toThrow("separate secure origin");
  });

  it("allows distinct HTTP loopback origins for local development", () => {
    expect(
      safePreviewOrigin(
        "http://localhost:5174/launch",
        "http://localhost:5173",
      ),
    ).toBe("http://localhost:5174");
    expect(() =>
      safePreviewOrigin(
        "http://preview.example/launch",
        "http://localhost:5173",
      ),
    ).toThrow("separate secure origin");
    expect(() =>
      safePreviewOrigin(
        "http://localhost:5173/launch",
        "http://localhost:5173",
      ),
    ).toThrow("separate secure origin");
  });

  it("embeds the exact session with only the required sandbox permissions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          url: `${previewOrigin}/launch?token=signed`,
          expiresAt: "2026-08-22T13:05:00.000Z",
        }),
      ),
    );
    render(
      <RevisionReviewCanvas
        projectId={projectId}
        revisionId={revisionId}
        commitSha={"a".repeat(40)}
        pauseRequest={0}
        onCommandPendingChange={() => undefined}
        onPositionChange={() => undefined}
        onPlayingChange={() => undefined}
      />,
    );

    const iframe = await previewIframe("Exact-build preview aaaaaaaa");
    expect(iframe.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin",
    );
    expect(iframe.getAttribute("allow")).toBe("fullscreen");
    expect(
      screen.getByRole("button", { name: "Play" }).hasAttribute("disabled"),
    ).toBe(true);
    const postMessage = vi.fn();
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: { postMessage },
    });
    fireEvent.load(iframe);
    expect(postMessage).toHaveBeenCalledWith(
      reviewCommand({ type: "request-state" }, lastCommandId(postMessage)),
      previewOrigin,
    );
  });

  it("keeps frame feedback pending until the requested seek is visible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          url: `${previewOrigin}/launch?token=signed`,
          expiresAt: "2026-08-22T13:05:00.000Z",
        }),
      ),
    );
    const onCommandPendingChange = vi.fn();
    const onPositionChange = vi.fn();
    const onPlayingChange = vi.fn();
    const { rerender } = render(
      <RevisionReviewCanvas
        projectId={projectId}
        revisionId={revisionId}
        commitSha={"a".repeat(40)}
        pauseRequest={0}
        onCommandPendingChange={onCommandPendingChange}
        onPositionChange={onPositionChange}
        onPlayingChange={onPlayingChange}
      />,
    );

    const iframe = await previewIframe("Exact-build preview aaaaaaaa");
    const postMessage = vi.fn();
    const previewWindow = fromPartial<Window>({ postMessage });
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: previewWindow,
    });
    const sendState = (
      frame: number,
      playing = false,
      acknowledgedCommandId = 0,
    ) => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: previewState(frame, playing, acknowledgedCommandId),
          origin: previewOrigin,
          source: previewWindow,
        }),
      );
    };
    sendState(0);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Play" }).hasAttribute("disabled"),
      ).toBe(false),
    );

    fireEvent.change(screen.getByLabelText("Review frame"), {
      target: { value: "123" },
    });
    expect(onCommandPendingChange).toHaveBeenLastCalledWith(true);
    const seekCommandId = lastCommandId(postMessage);

    sendState(0);
    expect(onCommandPendingChange).toHaveBeenLastCalledWith(true);

    sendState(123, false, seekCommandId);
    await waitFor(() =>
      expect(onCommandPendingChange).toHaveBeenLastCalledWith(false),
    );
    expect(onPositionChange).toHaveBeenLastCalledWith({
      durationInFrames: 360,
      frame: 123,
      fps: 30,
      revisionId,
    });

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(onCommandPendingChange).toHaveBeenLastCalledWith(true);
    const playCommandId = lastCommandId(postMessage);
    sendState(123, false, seekCommandId);
    expect(onCommandPendingChange).toHaveBeenLastCalledWith(true);
    sendState(123, true, playCommandId);
    await waitFor(() =>
      expect(onCommandPendingChange).toHaveBeenLastCalledWith(false),
    );

    rerender(
      <RevisionReviewCanvas
        projectId={projectId}
        revisionId={revisionId}
        commitSha={"a".repeat(40)}
        pauseRequest={1}
        onCommandPendingChange={onCommandPendingChange}
        onPositionChange={onPositionChange}
        onPlayingChange={onPlayingChange}
      />,
    );
    await waitFor(() =>
      expect(onCommandPendingChange).toHaveBeenLastCalledWith(true),
    );
    const pauseCommandId = lastCommandId(postMessage);
    sendState(123, false, pauseCommandId);
    await waitFor(() =>
      expect(onCommandPendingChange).toHaveBeenLastCalledWith(false),
    );
  });

  it("validates source, origin, syntax, and exact-origin commands", () => {
    const frameWindow = window;
    const state = previewState(123);

    expect(
      reviewStateFromMessage(
        { data: state, origin: previewOrigin, source: frameWindow },
        frameWindow,
        previewOrigin,
      ),
    ).toEqual(state);
    expect(
      reviewStateFromMessage(
        {
          data: state,
          origin: "https://attacker.example",
          source: frameWindow,
        },
        frameWindow,
        previewOrigin,
      ),
    ).toBeNull();
    expect(
      reviewStateFromMessage(
        {
          data: { ...state, version: 2 },
          origin: previewOrigin,
          source: frameWindow,
        },
        frameWindow,
        previewOrigin,
      ),
    ).toBeNull();
    expect(reviewCommand({ type: "seek", frame: 210 }, 7)).toEqual({
      source: studioReviewSource,
      version: reviewProtocolVersion,
      commandId: 7,
      type: "seek",
      frame: 210,
    });
  });

  it("offers retry when session creation fails", async () => {
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse({ error: "Preview unavailable" }, 503)
          : jsonResponse({
              url: `${previewOrigin}/launch?token=recovered`,
              expiresAt: "2026-08-22T13:05:00.000Z",
            });
      }),
    );
    render(
      <RevisionReviewCanvas
        projectId={projectId}
        revisionId={revisionId}
        commitSha={"b".repeat(40)}
        pauseRequest={0}
        onCommandPendingChange={() => undefined}
        onPositionChange={() => undefined}
        onPlayingChange={() => undefined}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Retry preview" }),
    );
    await screen.findByTitle("Exact-build preview bbbbbbbb");
    expect(attempts).toBe(2);
  });
});
