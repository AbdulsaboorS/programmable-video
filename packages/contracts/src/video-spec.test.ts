import { describe, expect, it } from "vitest";

import {
  managedVideoMaxDurationSeconds,
  managedVideoSpecSchema,
  videoSpec,
} from "./video-spec";

describe("managed video specification", () => {
  it("allows Stream uploads through the longest managed duration", () => {
    expect(managedVideoMaxDurationSeconds).toBe(15);
  });

  it.each([360, 450])("accepts %i-frame managed videos", (durationInFrames) => {
    expect(
      managedVideoSpecSchema.parse({ ...videoSpec, durationInFrames }),
    ).toEqual({ ...videoSpec, durationInFrames });
  });

  it.each([0, 359, 361, 449, 451, 900])(
    "rejects unsupported duration %i",
    (durationInFrames) => {
      expect(() =>
        managedVideoSpecSchema.parse({ ...videoSpec, durationInFrames }),
      ).toThrow();
    },
  );

  it("keeps dimensions and frame rate fixed", () => {
    expect(() =>
      managedVideoSpecSchema.parse({
        ...videoSpec,
        width: 1920,
        durationInFrames: 450,
      }),
    ).toThrow();
  });
});
