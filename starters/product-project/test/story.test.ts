import { describe, expect, it } from "vitest";

import { defaultStory, productStorySchema, videoSpec } from "../src/story";

describe("product story", () => {
  it("keeps valid defaults and a fixed video specification", () => {
    expect(productStorySchema.parse(defaultStory)).toEqual(defaultStory);
    expect(videoSpec).toEqual({
      width: 1280,
      height: 720,
      fps: 30,
      durationInFrames: 360,
    });
  });

  it("rejects unknown and empty story values", () => {
    expect(
      productStorySchema.safeParse({ ...defaultStory, productName: "" })
        .success,
    ).toBe(false);
    expect(
      productStorySchema.safeParse({ ...defaultStory, extra: "value" }).success,
    ).toBe(false);
  });
});
