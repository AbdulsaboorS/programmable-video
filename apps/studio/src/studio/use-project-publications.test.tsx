// @vitest-environment happy-dom

import {
  finishingContainBackground,
  finishingSpecVersion,
  type ManagedPublication,
} from "@programmable-video/contracts";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useProjectPublications,
  type ProjectPublicationOperations,
} from "./use-project-publications";

const loadPublications =
  vi.fn<ProjectPublicationOperations["loadPublications"]>();
const retryPublication =
  vi.fn<ProjectPublicationOperations["retryPublication"]>();
const operations: ProjectPublicationOperations = {
  loadPublications,
  retryPublication,
};

const projectId = "0198c7d4-a5e6-7000-8000-000000000000";

function publication(
  publicationNumber: number,
  attempt: number,
  updatedAt = `2026-08-26T12:00:0${attempt}.000Z`,
): ManagedPublication {
  const suffix = String(publicationNumber).padStart(12, "0");
  return {
    id: `0198c7d4-a5e6-7000-9000-${suffix}`,
    projectId,
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
        id: `0198c7d4-a5e6-7000-a000-${String(attempt).padStart(12, "0")}`,
        attempt,
        status: attempt === 1 ? "failed" : "queued",
        error: attempt === 1 ? "Render failed" : null,
        streamVideoId: null,
        playback: { status: "pending" },
        captions: { status: "not_requested" },
        download: { status: "not_requested" },
        createdAt: "2026-08-26T12:00:00.000Z",
        updatedAt,
      },
    ],
    createdAt: `2026-08-26T11:00:0${publicationNumber}.000Z`,
  };
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("useProjectPublications", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loadPublications.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("loads immediately and polls every three seconds", async () => {
    const first = publication(1, 1);
    const second = publication(2, 1);
    loadPublications
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([first, second]);

    const { result } = renderHook(() =>
      useProjectPublications(projectId, operations),
    );
    expect(result.current.loading).toBe(true);
    await flush();
    expect(result.current.publications).toEqual([first]);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_999);
    });
    expect(loadPublications).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(loadPublications).toHaveBeenCalledTimes(2);
    expect(result.current.publications).toEqual([second, first]);
  });

  it("retains the last good state when a poll fails", async () => {
    const current = publication(1, 1);
    loadPublications
      .mockResolvedValueOnce([current])
      .mockRejectedValueOnce(new Error("Publication API unavailable"));
    const { result } = renderHook(() =>
      useProjectPublications(projectId, operations),
    );
    await flush();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(result.current.publications).toEqual([current]);
    expect(result.current.error).toBe("Publication API unavailable");
  });

  it("aborts and fences polling when recording an external mutation", async () => {
    let resolveInitial: (value: ManagedPublication[]) => void = () => undefined;
    let initialSignal: AbortSignal | undefined;
    loadPublications.mockImplementationOnce(
      (_projectId: string, signal?: AbortSignal) => {
        initialSignal = signal;
        return new Promise<ManagedPublication[]>((resolve) => {
          resolveInitial = resolve;
        });
      },
    );
    const stale = publication(1, 1);
    const recorded = publication(1, 2);
    const { result } = renderHook(() =>
      useProjectPublications(projectId, operations),
    );

    act(() => result.current.record(recorded));
    expect(initialSignal?.aborted).toBe(true);
    expect(result.current.publications).toEqual([recorded]);
    await act(async () => resolveInitial([stale]));
    expect(result.current.publications).toEqual([recorded]);

    loadPublications.mockResolvedValueOnce([stale]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(result.current.publications).toEqual([recorded]);
  });

  it("retries a publication and exposes its busy state", async () => {
    const failed = publication(1, 1);
    const retried = publication(1, 2);
    let resolveRetry: (value: ManagedPublication) => void = () => undefined;
    retryPublication.mockReturnValueOnce(
      new Promise<ManagedPublication>((resolve) => {
        resolveRetry = resolve;
      }),
    );
    loadPublications.mockResolvedValueOnce([failed]);
    const { result } = renderHook(() =>
      useProjectPublications(projectId, operations),
    );
    await flush();

    let retryPromise: Promise<void>;
    act(() => {
      retryPromise = result.current.retry(failed);
    });
    expect(result.current.busyPublicationId).toBe(failed.id);
    expect(retryPublication).toHaveBeenCalledWith(projectId, failed.id);

    await act(async () => {
      resolveRetry(retried);
      await retryPromise!;
    });
    expect(result.current.busyPublicationId).toBeUndefined();
    expect(result.current.publications).toEqual([retried]);
  });

  it("restarts polling with a replaced load operation and fences stale results", async () => {
    let resolveStale: (value: ManagedPublication[]) => void = () => undefined;
    let staleSignal: AbortSignal | undefined;
    const firstLoad = vi.fn<ProjectPublicationOperations["loadPublications"]>(
      (_projectId, signal) => {
        staleSignal = signal;
        return new Promise((resolve) => {
          resolveStale = resolve;
        });
      },
    );
    const current = publication(2, 1);
    const stale = publication(1, 1);
    const nextLoad = vi
      .fn<ProjectPublicationOperations["loadPublications"]>()
      .mockResolvedValue([current]);
    const firstOperations = { ...operations, loadPublications: firstLoad };
    const nextOperations = { ...operations, loadPublications: nextLoad };
    const { result, rerender } = renderHook(
      (props) => useProjectPublications(projectId, props.operations),
      { initialProps: { operations: firstOperations } },
    );

    rerender({ operations: nextOperations });
    await flush();
    expect(staleSignal?.aborted).toBe(true);
    expect(nextLoad).toHaveBeenCalledTimes(1);
    expect(result.current.publications).toEqual([current]);

    await act(async () => resolveStale([stale]));
    expect(result.current.publications).toEqual([current]);
  });
});
