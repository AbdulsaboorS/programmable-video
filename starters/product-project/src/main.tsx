import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { ProductComposition } from "./ProductComposition";
import "./composition.css";
import {
  clampReviewFrame,
  elapsedReviewFrame,
  parseReviewCommand,
  reviewState,
} from "./review-bridge";
import { defaultStory, videoSpec } from "./story";
import "./preview.css";

function Preview() {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [acknowledgedCommandId, setAcknowledgedCommandId] = useState(0);
  const animationRef = useRef<number | undefined>(undefined);
  const frameRef = useRef(frame);
  const parentOrigin = (() => {
    if (window.parent === window) return null;
    const configuredOrigin = new URLSearchParams(window.location.search).get(
      "parentOrigin",
    );
    if (!configuredOrigin) return null;
    try {
      return new URL(configuredOrigin).origin;
    } catch {
      return null;
    }
  })();

  frameRef.current = frame;

  useEffect(() => {
    if (!playing) return;
    const startFrame = frameRef.current;
    const startedAt = performance.now();
    const advance = (now: number) => {
      const nextFrame = elapsedReviewFrame(startFrame, now - startedAt);
      setFrame(nextFrame);
      if (nextFrame === videoSpec.durationInFrames - 1) {
        setPlaying(false);
        return;
      }
      animationRef.current = requestAnimationFrame(advance);
    };
    animationRef.current = requestAnimationFrame(advance);
    return () => {
      if (animationRef.current !== undefined) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [playing]);

  useEffect(() => {
    if (!parentOrigin) return;
    window.parent.postMessage(
      reviewState(frame, playing, acknowledgedCommandId),
      parentOrigin,
    );
  }, [acknowledgedCommandId, frame, parentOrigin, playing]);

  useEffect(() => {
    if (!parentOrigin) return;
    const receiveCommand = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== parentOrigin)
        return;
      const command = parseReviewCommand(event.data);
      if (!command) return;
      setAcknowledgedCommandId(command.commandId);
      if (command.type === "play") {
        if (frameRef.current === videoSpec.durationInFrames - 1) setFrame(0);
        setPlaying(true);
      } else if (command.type === "pause") {
        setPlaying(false);
      } else if (command.type === "seek") {
        setPlaying(false);
        setFrame(clampReviewFrame(command.frame));
      }
    };
    window.addEventListener("message", receiveCommand);
    return () => window.removeEventListener("message", receiveCommand);
  }, [parentOrigin]);

  return (
    <div
      className="pv-preview-shell"
      data-embedded={parentOrigin ? "true" : "false"}
    >
      <div className="pv-preview-stage">
        <div className="pv-preview-viewport">
          <ProductComposition frame={frame} story={defaultStory} />
        </div>
      </div>
      <div className="pv-preview-controls">
        <button
          type="button"
          onClick={() => {
            if (
              !playing &&
              frameRef.current === videoSpec.durationInFrames - 1
            ) {
              setFrame(0);
            }
            setPlaying((value) => !value);
          }}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <label className="pv-preview-control">
          <span>
            Frame {frame} / {videoSpec.durationInFrames - 1}
          </span>
          <input
            type="range"
            min="0"
            max={videoSpec.durationInFrames - 1}
            value={frame}
            onChange={(event) => {
              setPlaying(false);
              setFrame(clampReviewFrame(Number(event.target.value)));
            }}
          />
        </label>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Preview root is missing");

createRoot(root).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
