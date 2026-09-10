import { videoSpec } from "@programmable-video/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { createPreviewSession } from "./project-api";
import {
  reviewCommand,
  reviewStateFromMessage,
  type ReviewState,
} from "./review-protocol";

export interface ReviewPosition {
  durationInFrames: number;
  frame: number;
  fps: number;
  revisionId: string;
}

export interface RevisionReviewCanvasProps {
  commitSha: string;
  pauseRequest: number;
  projectId: string;
  revisionId: string;
  onCommandPendingChange: (pending: boolean) => void;
  onPlayingChange: (playing: boolean) => void;
  onPositionChange: (position: ReviewPosition) => void;
}

export function formatReviewTime(frame: number, fps: number): string {
  const totalMilliseconds = Math.floor((frame * 1_000) / fps);
  const minutes = Math.floor(totalMilliseconds / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1_000);
  const milliseconds = totalMilliseconds % 1_000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

export function safePreviewOrigin(
  sessionUrl: string,
  studioOrigin: string,
): string {
  const url = new URL(sessionUrl);
  const studioUrl = new URL(studioOrigin);
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const localDevelopment =
    url.protocol === "http:" &&
    studioUrl.protocol === "http:" &&
    loopbackHosts.has(url.hostname) &&
    loopbackHosts.has(studioUrl.hostname);
  if (
    (url.protocol !== "https:" && !localDevelopment) ||
    url.origin === studioUrl.origin
  ) {
    throw new Error("Preview session must use a separate secure origin");
  }
  return url.origin;
}

export function RevisionReviewCanvas({
  commitSha,
  pauseRequest,
  projectId,
  revisionId,
  onCommandPendingChange,
  onPlayingChange,
  onPositionChange,
}: RevisionReviewCanvasProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const commandIdRef = useRef(0);
  const pendingCommandIdRef = useRef<number | undefined>(undefined);
  const [reload, setReload] = useState(0);
  const [sessionUrl, setSessionUrl] = useState<string>();
  const [previewOrigin, setPreviewOrigin] = useState<string>();
  const [state, setState] = useState<ReviewState>();
  const [error, setError] = useState<string>();
  const [fullscreen, setFullscreen] = useState(false);
  const [pendingCommandId, setPendingCommandId] = useState<number>();
  const notifyCommandPendingChange = useEffectEvent(onCommandPendingChange);
  const notifyPlayingChange = useEffectEvent(onPlayingChange);
  const notifyPositionChange = useEffectEvent(onPositionChange);

  useEffect(() => {
    let active = true;
    setSessionUrl(undefined);
    setPreviewOrigin(undefined);
    setState(undefined);
    setError(undefined);
    pendingCommandIdRef.current = undefined;
    setPendingCommandId(undefined);
    notifyCommandPendingChange(false);
    notifyPlayingChange(false);
    void createPreviewSession(projectId, revisionId)
      .then((session) => {
        if (!active) return;
        const origin = safePreviewOrigin(session.url, window.location.origin);
        setSessionUrl(session.url);
        setPreviewOrigin(origin);
      })
      .catch((sessionError) => {
        if (!active) return;
        setError(
          sessionError instanceof Error
            ? sessionError.message
            : "Could not load the exact-build preview",
        );
      });
    return () => {
      active = false;
    };
  }, [projectId, reload, revisionId]);

  useEffect(() => {
    if (!sessionUrl || state) return;
    const timer = window.setTimeout(() => {
      setError("The exact-build preview did not connect");
    }, 15_000);
    return () => window.clearTimeout(timer);
  }, [sessionUrl, state]);

  useEffect(() => {
    if (!previewOrigin) return;
    const receiveState = (event: MessageEvent<unknown>) => {
      if (
        event.source !== iframeRef.current?.contentWindow ||
        event.origin !== previewOrigin
      ) {
        return;
      }
      const nextState = reviewStateFromMessage(
        event,
        iframeRef.current?.contentWindow ?? null,
        previewOrigin,
      );
      if (!nextState) return;
      const pendingCommand = pendingCommandIdRef.current;
      if (
        pendingCommand !== undefined &&
        nextState.acknowledgedCommandId >= pendingCommand
      ) {
        pendingCommandIdRef.current = undefined;
        setPendingCommandId(undefined);
        notifyCommandPendingChange(false);
      }
      setState(nextState);
      setError(undefined);
      notifyPlayingChange(nextState.playing);
      notifyPositionChange({
        durationInFrames: nextState.spec.durationInFrames,
        frame: nextState.frame,
        fps: nextState.spec.fps,
        revisionId,
      });
    };
    window.addEventListener("message", receiveState);
    return () => window.removeEventListener("message", receiveState);
  }, [previewOrigin, revisionId]);

  const send = (
    command:
      | { type: "request-state" }
      | { type: "play" }
      | { type: "pause" }
      | { type: "seek"; frame: number },
  ) => {
    const previewWindow = iframeRef.current?.contentWindow;
    if (!previewOrigin || !previewWindow) return;
    const commandId = commandIdRef.current + 1;
    commandIdRef.current = commandId;
    if (command.type !== "request-state") {
      pendingCommandIdRef.current = commandId;
      setPendingCommandId(commandId);
      notifyCommandPendingChange(true);
    }
    previewWindow.postMessage(reviewCommand(command, commandId), previewOrigin);
  };

  useEffect(() => {
    if (!sessionUrl || !previewOrigin || state) return;
    const requestState = () => send({ type: "request-state" });
    requestState();
    const timer = window.setInterval(requestState, 1_000);
    return () => window.clearInterval(timer);
  }, [previewOrigin, sessionUrl, state]);

  useEffect(() => {
    if (pendingCommandId === undefined) return;
    const timer = window.setTimeout(() => {
      setError("The exact-build preview did not apply the control change");
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [pendingCommandId]);

  useEffect(() => {
    if (pauseRequest > 0) send({ type: "pause" });
  }, [pauseRequest]);

  useEffect(() => {
    const updateFullscreen = () => {
      setFullscreen(document.fullscreenElement === canvasRef.current);
    };
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () =>
      document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement === canvasRef.current) {
        await document.exitFullscreen();
        return;
      }
      if (!canvasRef.current?.requestFullscreen) {
        throw new Error("Fullscreen is not available in this browser");
      }
      await canvasRef.current.requestFullscreen();
    } catch (fullscreenError) {
      setError(
        fullscreenError instanceof Error
          ? fullscreenError.message
          : "Could not enter fullscreen",
      );
    }
  };

  const currentFrame = state?.frame ?? 0;
  const durationInFrames =
    state?.spec.durationInFrames ?? videoSpec.durationInFrames;
  const fps = state?.spec.fps ?? videoSpec.fps;
  const ready = state !== undefined;

  return (
    <div className="review-canvas" ref={canvasRef}>
      <div className="review-stage">
        {sessionUrl ? (
          <iframe
            ref={iframeRef}
            src={sessionUrl}
            title={`Exact-build preview ${commitSha.slice(0, 8)}`}
            sandbox="allow-scripts allow-same-origin"
            allow="fullscreen"
            allowFullScreen
            onLoad={() => send({ type: "request-state" })}
          />
        ) : (
          <div className="review-stage-status" role="status">
            <span className="status-kicker">Exact build</span>
            <span className="activity-dot" />
            <strong>
              {error ? "Preview unavailable" : "Loading exact build"}
            </strong>
            <p>{error ?? "Creating a private five-minute review session."}</p>
            {error && (
              <button
                type="button"
                onClick={() => setReload((value) => value + 1)}
              >
                Retry preview
              </button>
            )}
          </div>
        )}
      </div>
      <div className="review-controls">
        <button
          type="button"
          disabled={!ready}
          onClick={() => send({ type: state?.playing ? "pause" : "play" })}
        >
          {state?.playing ? "Pause" : "Play"}
        </button>
        <label>
          <span className="review-control-label">
            <span>Frame {currentFrame}</span>
            <span>
              {formatReviewTime(currentFrame, fps)} /{" "}
              {formatReviewTime(durationInFrames, fps)}
            </span>
          </span>
          <input
            aria-label="Review frame"
            type="range"
            min="0"
            max={durationInFrames - 1}
            value={currentFrame}
            disabled={!ready}
            onChange={(event) =>
              send({ type: "seek", frame: Number(event.target.value) })
            }
          />
        </label>
        <button
          type="button"
          disabled={!ready}
          onClick={() => void toggleFullscreen()}
        >
          {fullscreen ? "Exit fullscreen" : "Fullscreen"}
        </button>
      </div>
      {error && sessionUrl && (
        <div className="review-inline-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setReload((value) => value + 1)}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
