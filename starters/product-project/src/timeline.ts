import { videoSpec } from "./story";

export const scenes = {
  establish: { start: 0, end: 89 },
  demonstrate: { start: 90, end: 269 },
  outcome: { start: 270, end: videoSpec.durationInFrames - 1 },
} as const;

export function progress(frame: number, start: number, end: number): number {
  if (end <= start) return frame >= end ? 1 : 0;
  return Math.max(0, Math.min(1, (frame - start) / (end - start)));
}

export function productFrame(frame: number) {
  const finiteFrame = Number.isFinite(frame) ? frame : 0;
  const safeFrame = Math.max(
    0,
    Math.min(videoSpec.durationInFrames - 1, Math.round(finiteFrame)),
  );
  return {
    frame: safeFrame,
    establish: progress(
      safeFrame,
      scenes.establish.start,
      scenes.establish.end,
    ),
    demonstrate: progress(
      safeFrame,
      scenes.demonstrate.start,
      scenes.demonstrate.end,
    ),
    outcome: progress(safeFrame, scenes.outcome.start, scenes.outcome.end),
  };
}
