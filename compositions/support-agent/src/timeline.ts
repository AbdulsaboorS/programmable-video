import { videoSpec } from "@programmable-video/contracts";

export const supportAgentScenes = [
  { id: "request", label: "Request", start: 0, end: 74 },
  { id: "resources", label: "Resources", start: 75, end: 179 },
  { id: "conclusion", label: "Conclusion", start: 180, end: 254 },
  { id: "draft", label: "Draft", start: 255, end: 359 },
] as const;

export type SupportAgentScene = (typeof supportAgentScenes)[number];

export interface SceneMotion {
  opacity: number;
  translateY: number;
}

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

export function easeOutCubic(progress: number): number {
  return 1 - Math.pow(1 - clamp(progress, 0, 1), 3);
}

export function getScene(frame: number): SupportAgentScene {
  const safeFrame = clamp(Math.floor(frame), 0, videoSpec.durationInFrames - 1);
  return (
    supportAgentScenes.find(
      (scene) => safeFrame >= scene.start && safeFrame <= scene.end,
    ) ?? supportAgentScenes[0]
  );
}

export function sceneProgress(frame: number, scene: SupportAgentScene): number {
  return interpolate(frame, scene.start, scene.end);
}

export function sceneMotion(
  frame: number,
  scene: SupportAgentScene,
): SceneMotion {
  const enter = easeOutCubic(interpolate(frame, scene.start, scene.start + 12));

  return {
    opacity: interpolate(enter, 0, 1, 0.35, 1),
    translateY: interpolate(enter, 0, 1, 18, 0),
  };
}

export function staggeredReveal(
  frame: number,
  start: number,
  index: number,
  stagger = 7,
  duration = 12,
): number {
  const itemStart = start + index * stagger;
  return easeOutCubic(interpolate(frame, itemStart, itemStart + duration));
}
