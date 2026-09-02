import { describe, expect, it } from "vitest";

import { productFrame, progress, scenes } from "../src/timeline";

describe("product timeline", () => {
  it("clamps interpolation and invalid ranges", () => {
    expect(progress(-1, 0, 10)).toBe(0);
    expect(progress(5, 0, 10)).toBe(0.5);
    expect(progress(11, 0, 10)).toBe(1);
    expect(progress(10, 10, 10)).toBe(1);
  });

  it("covers scene boundaries and the final hold", () => {
    expect(productFrame(scenes.establish.start).establish).toBe(0);
    expect(productFrame(scenes.establish.end).establish).toBe(1);
    expect(productFrame(scenes.demonstrate.start).demonstrate).toBe(0);
    expect(productFrame(scenes.demonstrate.end).demonstrate).toBe(1);
    expect(productFrame(scenes.outcome.start).outcome).toBe(0);
    expect(productFrame(scenes.outcome.end)).toMatchObject({
      frame: 359,
      establish: 1,
      demonstrate: 1,
      outcome: 1,
    });
    expect(productFrame(999).frame).toBe(359);
    expect(productFrame(Number.NaN).frame).toBe(0);
    expect(productFrame(Number.POSITIVE_INFINITY).frame).toBe(0);
  });
});
