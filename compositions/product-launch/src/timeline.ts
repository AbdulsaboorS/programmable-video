export type ProductLaunchBeat = {
  id: "announcement" | "demonstration" | "benefits" | "call-to-action";
  start: number;
  end: number;
  enterFrames: number;
  exitFrames: number;
};

export const productLaunchBeats = [
  {
    id: "announcement",
    start: 0,
    end: 96,
    enterFrames: 0,
    exitFrames: 24,
  },
  {
    id: "demonstration",
    start: 72,
    end: 222,
    enterFrames: 24,
    exitFrames: 24,
  },
  {
    id: "benefits",
    start: 198,
    end: 312,
    enterFrames: 24,
    exitFrames: 24,
  },
  {
    id: "call-to-action",
    start: 288,
    end: 359,
    enterFrames: 24,
    exitFrames: 0,
  },
] as const satisfies readonly ProductLaunchBeat[];

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function interpolate(
  frame: number,
  inputStart: number,
  inputEnd: number,
  outputStart = 0,
  outputEnd = 1,
): number {
  if (inputStart === inputEnd) {
    return frame < inputStart ? outputStart : outputEnd;
  }
  const progress = clamp((frame - inputStart) / (inputEnd - inputStart), 0, 1);
  return outputStart + (outputEnd - outputStart) * progress;
}

export function easeOutQuint(progress: number): number {
  return 1 - Math.pow(1 - clamp(progress, 0, 1), 5);
}

export function revealProgress(
  frame: number,
  start: number,
  duration = 18,
): number {
  return easeOutQuint(interpolate(frame, start, start + duration));
}

export function layerProgress(frame: number, beat: ProductLaunchBeat): number {
  if (frame < beat.start || frame > beat.end) return 0;
  return beat.enterFrames === 0
    ? 1
    : interpolate(frame, beat.start, beat.start + beat.enterFrames);
}
