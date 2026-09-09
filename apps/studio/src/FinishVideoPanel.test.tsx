// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  finishingContainBackground,
  finishingSpecVersion,
  type ManagedPublication,
  type ProjectMediaAsset,
} from "@programmable-video/contracts";
import { useEffect, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FinishVideoPanel,
  type FinishVideoPanelOperations,
} from "./FinishVideoPanel";
import type { FinishedOutputPreviewProps } from "./FinishedOutputPreview";

const createPublication =
  vi.fn<FinishVideoPanelOperations["createPublication"]>();
const loadProjectMedia =
  vi.fn<FinishVideoPanelOperations["loadProjectMedia"]>();
const uploadProjectAudio =
  vi.fn<FinishVideoPanelOperations["uploadProjectAudio"]>();
const uploadProjectCaptions =
  vi.fn<FinishVideoPanelOperations["uploadProjectCaptions"]>();
const validateProjectAudio =
  vi.fn<FinishVideoPanelOperations["validateProjectAudio"]>();
const onPublicationCreated = vi.fn();
let previewStatusToReport: "ready" | undefined = "ready";

const operations: FinishVideoPanelOperations = {
  createPublication,
  loadProjectMedia,
  uploadProjectAudio,
  uploadProjectCaptions,
  validateProjectAudio,
};

function Preview({
  finishingSpec,
  onStatusChange,
}: FinishedOutputPreviewProps) {
  useEffect(() => {
    if (previewStatusToReport) onStatusChange(previewStatusToReport);
  }, [onStatusChange]);
  return (
    <div>
      Output preview: {finishingSpec.output.profile} {finishingSpec.output.fit}
    </div>
  );
}

const publication: ManagedPublication = {
  id: "0198c7d4-a5e6-7000-8000-000000000401",
  projectId: "0198c7d4-a5e6-7000-8000-000000000000",
  revisionId: "0198c7d4-a5e6-7000-8000-000000000103",
  buildAttempt: 1,
  manifestDigest: "a".repeat(64),
  inputDigest: "b".repeat(64),
  finishingSpecDigest: "c".repeat(64),
  finishingSpec: {
    version: finishingSpecVersion,
    trim: { startFrame: 0, endFrame: 360 },
    output: {
      profile: "landscape",
      width: 1280,
      height: 720,
      fit: "contain",
      containBackground: finishingContainBackground,
    },
    audio: null,
    captions: { mode: "none" },
  },
  attempts: [
    {
      id: "0198c7d4-a5e6-7000-8000-000000000402",
      attempt: 1,
      status: "queued",
      error: null,
      streamVideoId: null,
      playback: { status: "pending" },
      captions: { status: "not_requested" },
      download: { status: "not_requested" },
      createdAt: "2026-08-26T12:00:00.000Z",
      updatedAt: "2026-08-26T12:00:00.000Z",
    },
  ],
  createdAt: "2026-08-26T12:00:00.000Z",
};

const invalidAudio: ProjectMediaAsset = {
  id: "0198c7d4-a5e6-7000-8000-000000000601",
  projectId: publication.projectId,
  kind: "audio" as const,
  fileName: "voice.mp3",
  mediaType: "audio/mpeg" as const,
  byteSize: 3,
  sha256: "d".repeat(64),
  validationStatus: "invalid" as const,
  validationError: "Audio could not be decoded",
  decodedDurationMs: null,
  createdAt: "2026-08-26T12:00:00.000Z",
};

const validAudio: ProjectMediaAsset = {
  ...invalidAudio,
  id: "0198c7d4-a5e6-7000-8000-000000000602",
  validationStatus: "valid",
  validationError: null,
  decodedDurationMs: 12_000,
};

const panelProps: ComponentProps<typeof FinishVideoPanel> = {
  projectId: publication.projectId,
  projectName: "Acme Dashboard",
  revisionId: publication.revisionId,
  commitSha: `a${"b".repeat(39)}`,
  durationInFrames: 360,
  mobileView: "preview",
  onPublicationCreated,
  onReviewRequested: vi.fn(),
  operations,
  PreviewComponent: Preview,
};

function input(label: string | RegExp): HTMLInputElement {
  const element = screen.getByLabelText(label);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Expected input for ${String(label)}`);
  }
  return element;
}

function renderPanel(
  overrides: Partial<ComponentProps<typeof FinishVideoPanel>> = {},
) {
  return render(<FinishVideoPanel {...panelProps} {...overrides} />);
}

describe("FinishVideoPanel", () => {
  beforeEach(() => {
    previewStatusToReport = "ready";
    loadProjectMedia.mockResolvedValue([]);
    createPublication.mockResolvedValue(publication);
    validateProjectAudio.mockResolvedValue(invalidAudio);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("uses half-open trim bounds and invalidates confirmation when settings change", async () => {
    renderPanel();
    await screen.findByText("Output preview: landscape contain");

    expect(screen.getByText(/Includes frames 0 through 359/)).toBeDefined();
    const confirmation = screen.getByLabelText(
      /I checked the framing and trim/,
    );
    fireEvent.click(confirmation);
    expect(
      screen
        .getByRole("button", { name: "Publish video" })
        .hasAttribute("disabled"),
    ).toBe(false);

    fireEvent.change(screen.getByLabelText("End frame (exclusive)"), {
      target: { value: "300" },
    });
    expect(screen.getByText(/Includes frames 0 through 299/)).toBeDefined();
    expect(input(/I checked the framing and trim/).checked).toBe(false);
  });

  it("keeps confirmation and publication disabled until preview is ready", async () => {
    previewStatusToReport = undefined;
    renderPanel();

    const confirmation = await screen.findByLabelText(/Wait for the framing/);
    expect(confirmation.hasAttribute("disabled")).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Publish video" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps one idempotency key for unchanged retries and replaces it after a change", async () => {
    createPublication.mockRejectedValueOnce(new Error("Network failed"));
    renderPanel();
    await screen.findByText("Output preview: landscape contain");
    const confirmation = screen.getByLabelText(
      /I checked the framing and trim/,
    );
    fireEvent.click(confirmation);
    fireEvent.click(screen.getByRole("button", { name: "Publish video" }));
    await screen.findByText("Network failed");
    fireEvent.click(screen.getByRole("button", { name: "Publish video" }));
    await waitFor(() => expect(createPublication).toHaveBeenCalledTimes(2));
    expect(onPublicationCreated).toHaveBeenCalledWith(publication);

    const firstKey = createPublication.mock.calls[0]![2].idempotencyKey;
    expect(createPublication.mock.calls[1]![2].idempotencyKey).toBe(firstKey);

    fireEvent.click(screen.getByLabelText(/square/));
    fireEvent.click(confirmation);
    fireEvent.click(screen.getByRole("button", { name: "Publish video" }));
    await waitFor(() => expect(createPublication).toHaveBeenCalledTimes(3));
    expect(createPublication.mock.calls[2]![2].idempotencyKey).not.toBe(
      firstKey,
    );
  });

  it("warns about cover cropping and requires reconfirmation", async () => {
    renderPanel();
    await screen.findByText("Output preview: landscape contain");
    const confirmation = screen.getByLabelText(
      /I checked the framing and trim/,
    );
    fireEvent.click(confirmation);
    fireEvent.click(screen.getByLabelText(/cover/));

    expect(screen.getByText("Cover crops approved pixels")).toBeDefined();
    expect(screen.getByText("Output preview: landscape cover")).toBeDefined();
    expect(input(/I checked the framing and trim/).checked).toBe(false);
  });

  it("disables generated captions without validated audio", async () => {
    renderPanel();
    fireEvent.click(screen.getByText("Captions"));
    await screen.findByText(
      "Generated captions require a validated uploaded audio track.",
    );
    const option = screen.getByRole("option", {
      name: "Generate from uploaded audio",
    });
    expect(option.hasAttribute("disabled")).toBe(true);
  });

  it("keeps selected audio playback beside its finishing controls", async () => {
    loadProjectMedia.mockResolvedValue([validAudio]);
    renderPanel();
    fireEvent.click(screen.getByText("Audio"));
    fireEvent.change(await screen.findByLabelText("Selected audio"), {
      target: { value: validAudio.id },
    });

    const player = document.querySelector("audio");
    expect(player).not.toBeNull();
    expect(player?.getAttribute("src")).toBe(
      `/api/projects/${publication.projectId}/media/${validAudio.id}/content`,
    );
    expect(screen.getByText(/Publication volume: 100%/)).toBeDefined();
  });

  it("clears confirmation as soon as a media upload starts", async () => {
    uploadProjectAudio.mockReturnValue(new Promise(() => undefined));
    renderPanel();
    fireEvent.click(screen.getByText("Audio"));
    const confirmation = await screen.findByLabelText(
      /I checked the framing and trim/,
    );
    fireEvent.click(confirmation);
    expect(input(/I checked the framing and trim/).checked).toBe(true);

    fireEvent.change(screen.getByLabelText("Upload MP3, WAV, or M4A"), {
      target: {
        files: [new File([new Uint8Array([1, 2, 3])], "voice.mp3")],
      },
    });

    expect(input(/I checked the framing and trim/).checked).toBe(false);
    expect(
      screen
        .getByRole("button", { name: "Publish video" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps media errors beside the controls and retries invalid audio validation", async () => {
    loadProjectMedia.mockRejectedValue(new Error("Media API unavailable"));
    uploadProjectAudio.mockResolvedValue(invalidAudio);
    renderPanel();
    fireEvent.click(screen.getByText("Audio"));

    expect(
      await screen.findByText(
        "Media status may be stale: Media API unavailable",
      ),
    ).toBeDefined();
    fireEvent.change(screen.getByLabelText("Upload MP3, WAV, or M4A"), {
      target: {
        files: [new File([new Uint8Array([1, 2, 3])], "voice.mp3")],
      },
    });

    expect(await screen.findByText("voice.mp3")).toBeDefined();
    expect(screen.getByText("Audio could not be decoded")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Retry validation" }));
    await waitFor(() =>
      expect(validateProjectAudio).toHaveBeenCalledWith(
        publication.projectId,
        invalidAudio.id,
      ),
    );
  });

  it("restarts media polling with a replaced load operation", async () => {
    let resolveStale: (assets: ProjectMediaAsset[]) => void = () => undefined;
    let staleSignal: AbortSignal | undefined;
    const firstLoad = vi.fn<FinishVideoPanelOperations["loadProjectMedia"]>(
      (_projectId, signal) => {
        staleSignal = signal;
        return new Promise((resolve) => {
          resolveStale = resolve;
        });
      },
    );
    const nextLoad = vi
      .fn<FinishVideoPanelOperations["loadProjectMedia"]>()
      .mockResolvedValue([]);
    const view = renderPanel({
      operations: { ...operations, loadProjectMedia: firstLoad },
    });

    view.rerender(
      <FinishVideoPanel
        {...panelProps}
        operations={{ ...operations, loadProjectMedia: nextLoad }}
      />,
    );

    await waitFor(() => expect(nextLoad).toHaveBeenCalledTimes(1));
    expect(staleSignal?.aborted).toBe(true);
    resolveStale([invalidAudio]);
    await Promise.resolve();
    fireEvent.click(screen.getByText("Audio"));
    expect(screen.queryByText("voice.mp3")).toBeNull();
  });

  it("uses the production API operations by default", async () => {
    const fetchRequest = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/media")) {
          return new Response(JSON.stringify({ assets: [] }), { status: 200 });
        }
        if (url.endsWith("/publications")) {
          return new Response(JSON.stringify(publication), { status: 200 });
        }
        throw new Error(`Unexpected request: ${url}`);
      });
    render(
      <FinishVideoPanel
        projectId={publication.projectId}
        projectName="Acme Dashboard"
        revisionId={publication.revisionId}
        commitSha={`a${"b".repeat(39)}`}
        durationInFrames={360}
        mobileView="preview"
        onPublicationCreated={onPublicationCreated}
        onReviewRequested={vi.fn()}
        PreviewComponent={Preview}
      />,
    );

    const confirmation = await screen.findByLabelText(
      /I checked the framing and trim/,
    );
    fireEvent.click(confirmation);
    fireEvent.click(screen.getByRole("button", { name: "Publish video" }));

    await waitFor(() =>
      expect(onPublicationCreated).toHaveBeenCalledWith(publication),
    );
    expect(fetchRequest).toHaveBeenCalledWith(
      `/api/projects/${publication.projectId}/media`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchRequest).toHaveBeenCalledWith(
      `/api/projects/${publication.projectId}/revisions/${publication.revisionId}/publications`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("renders the approved preview and controls as mobile-selectable stage regions", async () => {
    renderPanel({ mobileView: "controls" });

    const preview = (
      await screen.findByText("Output preview: landscape contain")
    ).closest(".finish-preview");
    const controls = screen.getByRole("complementary");
    expect(preview?.getAttribute("data-mobile-active")).toBe("false");
    expect(controls.getAttribute("data-mobile-active")).toBe("true");
    expect(screen.getByText("Audio").closest("details")?.open).toBe(false);
    expect(screen.getByText("Captions").closest("details")?.open).toBe(false);
  });

  it("shows controls loading while the exact approved duration is unavailable", () => {
    const onReviewRequested = vi.fn();
    render(
      <FinishVideoPanel
        projectId={publication.projectId}
        projectName="Acme Dashboard"
        revisionId={publication.revisionId}
        commitSha={`a${"b".repeat(39)}`}
        mobileView="controls"
        onPublicationCreated={onPublicationCreated}
        onReviewRequested={onReviewRequested}
        operations={operations}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain(
      "Loading finishing controls",
    );
    expect(screen.queryByText(/Output preview:/)).toBeNull();
    expect(
      screen.getByRole("complementary").getAttribute("data-mobile-active"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Return to Review" }));
    expect(onReviewRequested).toHaveBeenCalledOnce();
  });

  it("loads a requested prior spec and resets confirmation and idempotency", async () => {
    const view = renderPanel();
    await screen.findByText("Output preview: landscape contain");
    const confirmation = screen.getByLabelText(
      /I checked the framing and trim/,
    );
    fireEvent.click(confirmation);
    fireEvent.click(screen.getByRole("button", { name: "Publish video" }));
    await waitFor(() => expect(createPublication).toHaveBeenCalledTimes(1));
    const firstKey = createPublication.mock.calls[0]![2].idempotencyKey;
    const requested = {
      ...publication.finishingSpec,
      trim: { startFrame: 12, endFrame: 300 },
      output: {
        ...publication.finishingSpec.output,
        profile: "square" as const,
        width: 1080 as const,
        height: 1080 as const,
      },
    };

    view.rerender(
      <FinishVideoPanel
        {...panelProps}
        requestedSpec={{ key: "prior-publication", spec: requested }}
      />,
    );

    await waitFor(() => expect(input("Start frame").value).toBe("12"));
    expect(input(/square/).checked).toBe(true);
    expect(input(/I checked the framing and trim/).checked).toBe(false);
    fireEvent.click(confirmation);
    fireEvent.click(screen.getByRole("button", { name: "Publish video" }));
    await waitFor(() => expect(createPublication).toHaveBeenCalledTimes(2));
    expect(createPublication.mock.calls[1]![2].idempotencyKey).not.toBe(
      firstKey,
    );
  });
});
