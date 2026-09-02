import {
  finishingProfiles,
  type FinishingSpec,
  videoSpec,
} from "@programmable-video/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { createPreviewSession } from "./project-api";
import { formatReviewTime, safePreviewOrigin } from "./RevisionReviewCanvas";
import {
  reviewCommand,
  reviewStateFromMessage,
  type ReviewState,
} from "./review-protocol";

export type FinishedPreviewStatus = "loading" | "ready" | "error";

export interface FinishedOutputPreviewProps {
  commitSha: string;
  finishingSpec: FinishingSpec;
  onStatusChange: (status: FinishedPreviewStatus) => void;
  projectId: string;
  revisionId: string;
}

export interface FinishedOutputPreviewOperations {
  createPreviewSession: typeof createPreviewSession;
}

const defaultOperations: FinishedOutputPreviewOperations = {
  createPreviewSession,
};

export function FinishedOutputPreview({
  commitSha,
  finishingSpec,
  onStatusChange,
  projectId,
  revisionId,
  operations = defaultOperations,
}: FinishedOutputPreviewProps & {
  operations?: FinishedOutputPreviewOperations;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const commandIdRef = useRef(0);
  const [reload, setReload] = useState(0);
  const [sessionUrl, setSessionUrl] = useState<string>();
  const [previewOrigin, setPreviewOrigin] = useState<string>();
  const [state, setState] = useState<ReviewState>();
  const [error, setError] = useState<string>();
  const notifyStatusChange = useEffectEvent(onStatusChange);
  const startPreviewSession = operations.createPreviewSession;
  const { fit, profile } = finishingSpec.output;
  const output = finishingProfiles[profile];
  const outputIsWider =
    output.width / output.height > videoSpec.width / videoSpec.height;
  const sizeByHeight = fit === "contain" ? outputIsWider : !outputIsWider;

  useEffect(() => {
    let active = true;
    setSessionUrl(undefined);
    setPreviewOrigin(undefined);
    setState(undefined);
    setError(undefined);
    notifyStatusChange("loading");
    void startPreviewSession(projectId, revisionId)
      .then((session) => {
        if (!active) return;
        const origin = safePreviewOrigin(session.url, window.location.origin);
        setSessionUrl(session.url);
        setPreviewOrigin(origin);
      })
      .catch((requestError) => {
        if (!active) return;
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Finished-output preview is unavailable",
        );
        notifyStatusChange("error");
      });
    return () => {
      active = false;
    };
  }, [projectId, reload, revisionId, startPreviewSession]);

  const send = (
    command:
      | { type: "request-state" }
      | { type: "play" }
      | { type: "pause" }
      | { type: "seek"; frame: number },
  ) => {
    const previewWindow = iframeRef.current?.contentWindow;
    if (!previewOrigin || !previewWindow) return;
    commandIdRef.current += 1;
    previewWindow.postMessage(
      reviewCommand(command, commandIdRef.current),
      previewOrigin,
    );
  };

  useEffect(() => {
    if (!previewOrigin) return;
    const receiveState: (event: MessageEvent) => void = (event) => {
      const nextState = reviewStateFromMessage(
        event,
        iframeRef.current?.contentWindow ?? null,
        previewOrigin,
      );
      if (!nextState) return;
      setState(nextState);
      setError(undefined);
      notifyStatusChange("ready");
    };
    window.addEventListener("message", receiveState);
    return () => window.removeEventListener("message", receiveState);
  }, [previewOrigin]);

  useEffect(() => {
    if (!sessionUrl || !previewOrigin || state) return;
    const requestState = () => send({ type: "request-state" });
    requestState();
    const interval = window.setInterval(requestState, 1_000);
    const timeout = window.setTimeout(() => {
      setError("The finished-output preview did not connect");
      notifyStatusChange("error");
    }, 15_000);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [previewOrigin, sessionUrl, state]);

  const currentFrame = state?.frame;
  const trimStart = finishingSpec.trim.startFrame;
  const trimEnd = finishingSpec.trim.endFrame - 1;
  const displayedFrame = Math.min(
    trimEnd,
    Math.max(trimStart, currentFrame ?? trimStart),
  );

  useEffect(() => {
    if (!state) return;
    if (state.frame < trimStart || state.frame > trimEnd) {
      if (state.playing) send({ type: "pause" });
      send({ type: "seek", frame: displayedFrame });
      return;
    }
    if (state.playing && state.frame >= trimEnd) {
      send({ type: "pause" });
      send({ type: "seek", frame: trimEnd });
    }
  }, [displayedFrame, state, trimEnd, trimStart]);

  const togglePlayback = () => {
    if (!state) return;
    if (state.playing) {
      send({ type: "pause" });
      return;
    }
    if (state.frame >= trimEnd) send({ type: "seek", frame: trimStart });
    send({ type: "play" });
  };

  const seek = (frame: number) => {
    if (state?.playing) send({ type: "pause" });
    send({
      type: "seek",
      frame: Math.min(trimEnd, Math.max(trimStart, frame)),
    });
  };

  return (
    <figure className="finished-output-preview">
      <div
        className="finished-output-viewport"
        data-fit={fit}
        style={{
          aspectRatio: `${output.width} / ${output.height}`,
          maxWidth: `${390 * (output.width / output.height)}px`,
        }}
      >
        {sessionUrl ? (
          <div
            className="finished-output-source"
            style={
              sizeByHeight
                ? {
                    height: "100%",
                    aspectRatio: `${videoSpec.width} / ${videoSpec.height}`,
                  }
                : {
                    width: "100%",
                    aspectRatio: `${videoSpec.width} / ${videoSpec.height}`,
                  }
            }
          >
            <iframe
              ref={iframeRef}
              src={sessionUrl}
              title={`Finished-output preview ${commitSha.slice(0, 8)}`}
              sandbox="allow-scripts allow-same-origin"
              allow="fullscreen"
              allowFullScreen
              onLoad={() => send({ type: "request-state" })}
            />
          </div>
        ) : (
          <span role={error ? "alert" : "status"}>
            {error ?? "Loading approved source"}
          </span>
        )}
      </div>
      <figcaption>
        <div className="finished-preview-heading">
          <strong>
            {profile} {output.width}x{output.height}
          </strong>
          <span>
            {fit === "contain"
              ? "Approved UI preserved"
              : "Center crop removes edge pixels"}
          </span>
        </div>
        <div className="trim-preview-controls">
          <button type="button" disabled={!state} onClick={togglePlayback}>
            {state?.playing ? "Pause" : "Play"}
          </button>
          <label>
            <span className="review-control-label">
              <span>Frame {displayedFrame}</span>
              <span>
                {formatReviewTime(displayedFrame - trimStart, videoSpec.fps)} /{" "}
                {formatReviewTime(trimEnd - trimStart + 1, videoSpec.fps)}
              </span>
            </span>
            <input
              aria-label="Finished video position"
              type="range"
              min={trimStart}
              max={trimEnd}
              value={displayedFrame}
              disabled={!state}
              onChange={(event) => seek(Number(event.target.value))}
            />
          </label>
          <span className="trim-boundary-labels">
            <span>In {formatReviewTime(trimStart, videoSpec.fps)}</span>
            <span>Out {formatReviewTime(trimEnd + 1, videoSpec.fps)}</span>
          </span>
        </div>
        <span className="finished-preview-summary">
          Audio:{" "}
          {finishingSpec.audio
            ? `${finishingSpec.audio.gainPercent}% gain`
            : "none"}
          . Captions: {finishingSpec.captions.mode}. Audio and captions are
          added during publication; this preview checks picture, crop, and trim.
        </span>
        {error && sessionUrl && (
          <span className="finished-preview-error" role="alert">
            {error}{" "}
            <button
              type="button"
              onClick={() => setReload((value) => value + 1)}
            >
              Retry preview
            </button>
          </span>
        )}
      </figcaption>
    </figure>
  );
}
