import { videoSpec } from "@programmable-video/contracts";
import type { CSSProperties, ReactNode } from "react";

import type { SupportAgentProps } from "./manifest";
import {
  getScene,
  interpolate,
  sceneMotion,
  staggeredReveal,
  supportAgentScenes,
  type SupportAgentScene,
} from "./timeline";

export type SupportAgentCompositionProps = {
  frame: number;
  props: SupportAgentProps;
};

function revealStyle(progress: number, distance = 12): CSSProperties {
  return {
    opacity: progress,
    transform: `translateY(${(1 - progress) * distance}px)`,
  };
}

function Scene({
  frame,
  scene,
  children,
}: {
  frame: number;
  scene: SupportAgentScene;
  children: ReactNode;
}) {
  const motion = sceneMotion(frame, scene);
  const active = frame >= scene.start && frame <= scene.end;

  return (
    <section
      className="sa-scene"
      aria-hidden={!active}
      style={{
        opacity: active ? motion.opacity : 0,
        transform: `translateY(${motion.translateY}px)`,
        visibility: active ? "visible" : "hidden",
      }}
    >
      {children}
    </section>
  );
}

function ChapterIndex({ frame }: { frame: number }) {
  const activeScene = getScene(frame);

  return (
    <nav className="sa-index" aria-label="Investigation chapters">
      <div className="sa-index-kicker">Case workflow</div>
      <ol>
        {supportAgentScenes.map((scene, index) => {
          const isActive = scene.id === activeScene.id;
          const isComplete = frame > scene.end;
          return (
            <li
              className={isActive ? "is-active" : isComplete ? "is-done" : ""}
              key={scene.id}
            >
              <span className="sa-index-number">0{index + 1}</span>
              <span>{scene.label}</span>
              <span className="sa-index-mark">{isComplete ? "OK" : "--"}</span>
            </li>
          );
        })}
      </ol>
      <div className="sa-index-note">
        <span>Method</span>
        Evidence before answer
      </div>
    </nav>
  );
}

function RequestScene({
  frame,
  props,
}: {
  frame: number;
  props: SupportAgentProps;
}) {
  const scene = supportAgentScenes[0];
  const quoteReveal = staggeredReveal(frame, scene.start + 10, 0, 0, 14);
  const factsReveal = staggeredReveal(frame, scene.start + 19, 0, 0, 14);

  return (
    <Scene frame={frame} scene={scene}>
      <div className="sa-section-label">01 / Incoming request</div>
      <h1>
        Read the signal,
        <br />
        <em>not the panic.</em>
      </h1>
      <blockquote style={revealStyle(quoteReveal, 16)}>
        &ldquo;Hi, I&apos;m {props.customerName} from {props.companyName}.
        We&apos;re seeing {props.issue} on {props.hostname}.&rdquo;
      </blockquote>
      <div className="sa-fact-strip" style={revealStyle(factsReveal)}>
        <div>
          <span>Reporter</span>
          {props.customerName}
        </div>
        <div>
          <span>Property</span>
          {props.hostname}
        </div>
        <div>
          <span>Region</span>
          {props.location}
        </div>
      </div>
    </Scene>
  );
}

const evidenceRows = [
  {
    ref: "EDGE-01",
    source: "Request trace",
    finding: "Origin connection timed out",
    state: "MATCH",
  },
  {
    ref: "POP-02",
    source: "Regional health",
    finding: "Elevated errors near reporter",
    state: "MATCH",
  },
  {
    ref: "DOC-03",
    source: "Error reference",
    finding: "522 points to origin reachability",
    state: "READ",
  },
] as const;

function ResourcesScene({
  frame,
  props,
}: {
  frame: number;
  props: SupportAgentProps;
}) {
  const scene = supportAgentScenes[1];

  return (
    <Scene frame={frame} scene={scene}>
      <div className="sa-section-label">02 / Evidence ledger</div>
      <div className="sa-title-row">
        <h1>Assemble the record.</h1>
        <p>Three checks. One accountable trail.</p>
      </div>
      <div className="sa-ledger">
        <div className="sa-ledger-head">
          <span>Ref.</span>
          <span>Source</span>
          <span>Finding</span>
          <span>Status</span>
        </div>
        {evidenceRows.map((row, index) => {
          const reveal = staggeredReveal(frame, scene.start + 14, index);
          const finding =
            index === 1
              ? `Errors cluster around ${props.location}`
              : index === 0
                ? `${props.hostname}: ${row.finding}`
                : row.finding;
          return (
            <div
              className="sa-ledger-row"
              key={row.ref}
              style={revealStyle(reveal, 10)}
            >
              <span>{row.ref}</span>
              <strong>{row.source}</strong>
              <span>{finding}</span>
              <b>{row.state}</b>
            </div>
          );
        })}
      </div>
      <div className="sa-margin-note">
        Observed behavior supports a network path issue. No unsupported
        certainty.
      </div>
    </Scene>
  );
}

function ConclusionScene({
  frame,
  props,
}: {
  frame: number;
  props: SupportAgentProps;
}) {
  const scene = supportAgentScenes[2];
  const line = staggeredReveal(frame, scene.start + 13, 0, 0, 16);
  const detail = staggeredReveal(frame, scene.start + 25, 0, 0, 14);

  return (
    <Scene frame={frame} scene={scene}>
      <div className="sa-section-label">03 / Working conclusion</div>
      <div className="sa-conclusion-rule" style={{ width: `${line * 100}%` }} />
      <p className="sa-verdict" style={revealStyle(line, 14)}>
        The evidence points to intermittent origin reachability from the edge,
        concentrated near <em>{props.location}</em>.
      </p>
      <div className="sa-confidence" style={revealStyle(detail)}>
        <span>Confidence / 0.82</span>
        <div>
          <i style={{ width: `${interpolate(detail, 0, 1, 0, 82)}%` }} />
        </div>
      </div>
      <div className="sa-next-check" style={revealStyle(detail)}>
        <span>Next useful check</span>
        Ask {props.companyName} to review firewall and origin availability for{" "}
        {props.hostname} during the reported windows.
      </div>
    </Scene>
  );
}

function DraftScene({
  frame,
  props,
}: {
  frame: number;
  props: SupportAgentProps;
}) {
  const scene = supportAgentScenes[3];
  const subject = staggeredReveal(frame, scene.start + 11, 0, 0, 12);
  const body = staggeredReveal(frame, scene.start + 20, 0, 0, 16);
  const ready = staggeredReveal(frame, scene.start + 48, 0, 0, 13);

  return (
    <Scene frame={frame} scene={scene}>
      <div className="sa-section-label">04 / Response draft</div>
      <div className="sa-draft-header" style={revealStyle(subject)}>
        <span>
          To / {props.customerName}, {props.companyName}
        </span>
        <strong>Re: {props.issue}</strong>
      </div>
      <div className="sa-letter" style={revealStyle(body, 10)}>
        <p>Hi {props.customerName},</p>
        <p>
          We reviewed the available traces for <b>{props.hostname}</b>. They
          indicate intermittent origin reachability, with the strongest signal
          around {props.location}.
        </p>
        <p>
          Please check origin availability and firewall rules during the
          affected windows. If the issue continues, send one recent timestamp
          and we&apos;ll correlate it with the edge trace.
        </p>
        <p>
          Best,
          <br />
          Support
        </p>
      </div>
      <div
        className="sa-ready-stamp"
        style={{
          opacity: ready,
          transform: `rotate(-2deg) scale(${0.92 + ready * 0.08})`,
        }}
      >
        Evidence checked / Ready to review
      </div>
    </Scene>
  );
}

export function SupportAgentComposition({
  frame,
  props,
}: SupportAgentCompositionProps) {
  const safeFrame = Math.max(
    0,
    Math.min(videoSpec.durationInFrames - 1, Math.floor(frame)),
  );
  const progress = interpolate(
    safeFrame,
    0,
    videoSpec.durationInFrames - 1,
    0,
    100,
  );

  return (
    <main className="support-agent-composition">
      <header className="sa-header">
        <div>
          <span>SUPPORT / FIELD NOTE</span>
          <strong>Incident worksheet</strong>
        </div>
        <div className="sa-case">
          CASE 522-{props.hostname.length.toString().padStart(2, "0")}
        </div>
      </header>
      <ChapterIndex frame={safeFrame} />
      <div className="sa-workspace">
        <RequestScene frame={safeFrame} props={props} />
        <ResourcesScene frame={safeFrame} props={props} />
        <ConclusionScene frame={safeFrame} props={props} />
        <DraftScene frame={safeFrame} props={props} />
      </div>
      <footer className="sa-footer">
        <span>
          {String(safeFrame).padStart(3, "0")} /{" "}
          {videoSpec.durationInFrames - 1} FRAMES
        </span>
        <div>
          <i style={{ width: `${progress}%` }} />
        </div>
        <span>
          {videoSpec.width}x{videoSpec.height} / {videoSpec.fps} FPS
        </span>
      </footer>
    </main>
  );
}
