import { describe, expect, it } from "vitest";

import {
  easeOutCubic,
  getScene,
  interpolate,
  sceneMotion,
  staggeredReveal,
  supportAgentScenes,
} from "./timeline";

describe("support agent timeline", () => {
  it.each([
    [0, "request"],
    [74, "request"],
    [75, "resources"],
    [179, "resources"],
    [180, "conclusion"],
    [254, "conclusion"],
    [255, "draft"],
    [359, "draft"],
  ] as const)("maps frame %i to %s", (frame, id) => {
    expect(getScene(frame).id).toBe(id);
  });

  it("clamps frames to the composition range", () => {
    expect(getScene(-10).id).toBe("request");
    expect(getScene(500).id).toBe("draft");
  });

  it("interpolates and clamps output values", () => {
    expect(interpolate(-1, 0, 10, 20, 40)).toBe(20);
    expect(interpolate(5, 0, 10, 20, 40)).toBe(30);
    expect(interpolate(11, 0, 10, 20, 40)).toBe(40);
  });

  it("uses stable easing and staggered reveals", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(staggeredReveal(10, 10, 0)).toBe(0);
    expect(staggeredReveal(22, 10, 0)).toBe(1);
    expect(staggeredReveal(22, 10, 1)).toBeGreaterThan(0);
    expect(staggeredReveal(22, 10, 1)).toBeLessThan(1);
  });

  it("keeps scene edges visible without blank transition frames", () => {
    const request = supportAgentScenes[0];
    expect(sceneMotion(request.start, request).opacity).toBe(0.35);
    expect(sceneMotion(request.start + 12, request).opacity).toBe(1);
    expect(sceneMotion(request.end, request).opacity).toBe(1);

    const draft = supportAgentScenes.at(-1)!;
    expect(sceneMotion(draft.end, draft)).toEqual({
      opacity: 1,
      translateY: 0,
    });
  });
});
