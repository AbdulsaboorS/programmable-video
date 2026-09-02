import { describe, expect, it } from "vitest";

import {
  easeOutQuint,
  interpolate,
  layerProgress,
  productLaunchBeats,
  revealProgress,
} from "./timeline";
import { productLaunchPropsSchema } from "./manifest";

describe("product launch timeline", () => {
  it("clamps interpolation and reveal progress", () => {
    expect(interpolate(-1, 0, 10, 20, 40)).toBe(20);
    expect(interpolate(5, 0, 10, 20, 40)).toBe(30);
    expect(interpolate(11, 0, 10, 20, 40)).toBe(40);
    expect(easeOutQuint(-1)).toBe(0);
    expect(easeOutQuint(2)).toBe(1);
    expect(revealProgress(20, 20)).toBe(0);
    expect(revealProgress(38, 20)).toBe(1);
  });

  it.each([
    [0, [1, 0, 0, 0]],
    [72, [1, 0, 0, 0]],
    [84, [1, 0.5, 0, 0]],
    [96, [1, 1, 0, 0]],
    [210, [0, 1, 0.5, 0]],
    [300, [0, 0, 1, 0.5]],
    [312, [0, 0, 1, 1]],
    [359, [0, 0, 0, 1]],
  ] as const)(
    "keeps frame %i covered by overlapping layers",
    (frame, expected) => {
      expect(
        productLaunchBeats.map((beat) => layerProgress(frame, beat)),
      ).toEqual(expected);
      expect(Math.max(...expected)).toBe(1);
    },
  );

  it("clamps layers outside their declared ranges", () => {
    expect(layerProgress(-1, productLaunchBeats[0])).toBe(0);
    expect(layerProgress(360, productLaunchBeats[3])).toBe(0);
  });

  it("requires exactly three non-empty benefits", () => {
    const props = {
      productName: "Vector",
      headline: "Launch",
      supportingCopy: "A complete launch story.",
      callToAction: "Start now",
    };

    expect(
      productLaunchPropsSchema.safeParse({ ...props, benefits: "One\nTwo" })
        .success,
    ).toBe(false);
    expect(
      productLaunchPropsSchema.safeParse({
        ...props,
        benefits: "One\nTwo\nThree\nFour",
      }).success,
    ).toBe(false);
    expect(
      productLaunchPropsSchema.safeParse({
        ...props,
        benefits: "One\n\nTwo\nThree",
      }).success,
    ).toBe(true);
  });
});
