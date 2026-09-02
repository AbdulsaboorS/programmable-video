import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineCompositionManifest, formatTime, videoSpec } from "./index";

describe("formatTime", () => {
  it("formats frames using the fixed frame rate", () => {
    expect(formatTime(255)).toBe("00:08.500");
  });
});

describe("defineCompositionManifest", () => {
  const propsSchema = z.object({ first: z.string(), second: z.string() });
  const manifest = {
    id: "test-composition",
    label: "Test composition",
    description: "Exercises manifest invariants.",
    spec: videoSpec,
    propsSchema,
    defaultProps: { first: "one", second: "two" },
    fields: [
      { key: "first", label: "First", control: "text", previewFrame: 0 },
      { key: "second", label: "Second", control: "text", previewFrame: 1 },
    ],
    reviewFrames: [0],
  } as const;

  it("rejects schemas that silently remove unknown props", () => {
    expect(() => defineCompositionManifest(manifest)).toThrow(
      "props schema must be strict",
    );
  });

  it("rejects field descriptors that do not follow schema order", () => {
    expect(() =>
      defineCompositionManifest({
        ...manifest,
        propsSchema: propsSchema.strict(),
        fields: [manifest.fields[1], manifest.fields[0]],
      }),
    ).toThrow("fields must match schema keys in order");
  });
});
