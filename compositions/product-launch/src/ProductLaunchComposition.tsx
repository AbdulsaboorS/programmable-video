import { videoSpec } from "@programmable-video/contracts";
import type { CSSProperties, ReactNode } from "react";

import signalGrid from "./assets/signal-grid.svg";
import type { ProductLaunchProps } from "./manifest";
import {
  interpolate,
  layerProgress,
  productLaunchBeats,
  revealProgress,
} from "./timeline";

export type ProductLaunchCompositionProps = {
  frame: number;
  props: ProductLaunchProps;
};

function revealStyle(progress: number, distance = 26): CSSProperties {
  return {
    opacity: progress,
    transform: `translateY(${(1 - progress) * distance}px)`,
  };
}

function LaunchLayer({
  className,
  progress,
  direction = "left",
  children,
}: {
  className: string;
  progress: number;
  direction?: "left" | "right";
  children: ReactNode;
}) {
  const hidden = progress === 0;
  const clipped = (1 - progress) * 100;
  return (
    <section
      className={`pl-layer ${className}`}
      aria-hidden={hidden}
      style={{
        opacity: hidden ? 0 : 1,
        visibility: hidden ? "hidden" : "visible",
        clipPath:
          direction === "left"
            ? `inset(0 ${clipped}% 0 0)`
            : `inset(0 0 0 ${clipped}%)`,
      }}
    >
      {children}
    </section>
  );
}

function Announcement({
  frame,
  props,
  progress,
}: {
  frame: number;
  props: ProductLaunchProps;
  progress: number;
}) {
  const name = revealProgress(frame, 0, 16);
  const headline = revealProgress(frame, 12, 20);
  const copy = revealProgress(frame, 30, 18);

  return (
    <LaunchLayer className="pl-announcement-layer" progress={progress}>
      <div className="pl-launch-code">LAUNCH SIGNAL / 001</div>
      <div className="pl-product-name" style={revealStyle(name, 18)}>
        {props.productName}
      </div>
      <h1 style={revealStyle(headline)}>{props.headline}</h1>
      <p className="pl-supporting-copy" style={revealStyle(copy, 16)}>
        {props.supportingCopy}
      </p>
      <div
        className="pl-pulse"
        style={{ transform: `scale(${interpolate(frame, 0, 72, 0.62, 1.3)})` }}
      />
    </LaunchLayer>
  );
}

function Demonstration({
  frame,
  props,
  progress,
}: {
  frame: number;
  props: ProductLaunchProps;
  progress: number;
}) {
  const beat = productLaunchBeats[1];
  const title = revealProgress(frame, beat.start + 10, 18);
  const flow = revealProgress(frame, beat.start + 25, 34);
  const signalPosition = interpolate(
    frame,
    beat.start + 28,
    beat.end - 18,
    3,
    97,
  );

  return (
    <LaunchLayer
      className="pl-demonstration-layer"
      progress={progress}
      direction="right"
    >
      <img className="pl-grid-art" src={signalGrid} alt="" />
      <div className="pl-demo-heading" style={revealStyle(title)}>
        <span>FROM ROUGH SIGNAL</span>
        <strong>to launch-ready story</strong>
      </div>
      <div className="pl-flow" style={revealStyle(flow, 12)}>
        <div className="pl-flow-card pl-flow-input">
          <span>01 / INPUT</span>
          <b>Scattered notes</b>
          <i>Briefs / feedback / decisions</i>
        </div>
        <div className="pl-flow-rail">
          <i style={{ left: `${signalPosition}%` }} />
        </div>
        <div className="pl-flow-card pl-flow-engine">
          <span>02 / {props.productName.toUpperCase()}</span>
          <b>Shape the signal</b>
          <i>One narrative system</i>
        </div>
        <div className="pl-flow-rail">
          <i style={{ left: `${signalPosition}%` }} />
        </div>
        <div className="pl-flow-card pl-flow-output">
          <span>03 / OUTPUT</span>
          <b>Ready to release</b>
          <i>Clear / aligned / alive</i>
        </div>
      </div>
      <p className="pl-demo-copy">{props.supportingCopy}</p>
    </LaunchLayer>
  );
}

function Benefits({
  frame,
  props,
  progress,
}: {
  frame: number;
  props: ProductLaunchProps;
  progress: number;
}) {
  const beat = productLaunchBeats[2];
  const benefits = props.benefits
    .split("\n")
    .map((benefit) => benefit.trim())
    .filter(Boolean);

  return (
    <LaunchLayer className="pl-benefits-layer" progress={progress}>
      <div className="pl-benefits-intro">
        <span>THREE FORCES / ONE RELEASE</span>
        <h2>Momentum, designed in.</h2>
      </div>
      <ol className="pl-benefit-list">
        {benefits.map((benefit, index) => {
          const progress = revealProgress(
            frame,
            beat.start + 16 + index * 13,
            18,
          );
          return (
            <li key={`${index}-${benefit}`} style={revealStyle(progress, 20)}>
              <span>0{index + 1}</span>
              <strong>{benefit}</strong>
              <i style={{ width: `${progress * 100}%` }} />
            </li>
          );
        })}
      </ol>
      <div className="pl-orbit" aria-hidden="true">
        <i />
        <b>{props.productName.slice(0, 1).toUpperCase()}</b>
      </div>
    </LaunchLayer>
  );
}

function CallToAction({
  frame,
  props,
  progress,
}: {
  frame: number;
  props: ProductLaunchProps;
  progress: number;
}) {
  const beat = productLaunchBeats[3];
  const title = revealProgress(frame, beat.start + 10, 18);
  const action = revealProgress(frame, beat.start + 27, 16);

  return (
    <LaunchLayer className="pl-cta-layer" progress={progress} direction="right">
      <div className="pl-cta-mark" style={revealStyle(title, 18)}>
        {props.productName.slice(0, 1).toUpperCase()}
      </div>
      <p style={revealStyle(title)}>THE SIGNAL IS LIVE</p>
      <h2 style={revealStyle(title)}>{props.productName}</h2>
      <div className="pl-cta" style={revealStyle(action, 12)}>
        {props.callToAction}
      </div>
      <span className="pl-final-note">
        BUILT FOR THE MOMENT BETWEEN IDEA AND IMPACT
      </span>
    </LaunchLayer>
  );
}

export function ProductLaunchComposition({
  frame,
  props,
}: ProductLaunchCompositionProps) {
  const safeFrame = Math.max(
    0,
    Math.min(videoSpec.durationInFrames - 1, Math.floor(frame)),
  );
  const layerProgresses = productLaunchBeats.map((beat) =>
    layerProgress(safeFrame, beat),
  );
  const progress = interpolate(
    safeFrame,
    0,
    videoSpec.durationInFrames - 1,
    0,
    100,
  );

  return (
    <main className="product-launch-composition">
      <div className="pl-background-word" aria-hidden="true">
        SIGNAL
      </div>
      <header className="pl-header">
        <strong>{props.productName}</strong>
        <span>PRODUCT RELEASE / 12 SEC</span>
        <i>LIVE</i>
      </header>
      <Announcement
        frame={safeFrame}
        props={props}
        progress={layerProgresses[0] ?? 0}
      />
      <Demonstration
        frame={safeFrame}
        props={props}
        progress={layerProgresses[1] ?? 0}
      />
      <Benefits
        frame={safeFrame}
        props={props}
        progress={layerProgresses[2] ?? 0}
      />
      <CallToAction
        frame={safeFrame}
        props={props}
        progress={layerProgresses[3] ?? 0}
      />
      <footer className="pl-footer">
        <span>{String(safeFrame).padStart(3, "0")}</span>
        <div>
          <i style={{ width: `${progress}%` }} />
        </div>
        <span>359</span>
      </footer>
    </main>
  );
}
