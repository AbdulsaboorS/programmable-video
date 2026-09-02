import { describe, expect, it } from "vitest";

import { browserCompositionRegistry } from "./browser";
import {
  compositionManifests,
  getCompositionManifest,
  parseContainerRenderRequest,
  parseRenderRequest,
} from "./index";

describe("composition registry", () => {
  it("has unique IDs and valid defaults", () => {
    const ids = compositionManifests.map((manifest) => manifest.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const manifest of compositionManifests) {
      expect(manifest.propsSchema.parse(manifest.defaultProps)).toEqual(
        manifest.defaultProps,
      );
      expect(getCompositionManifest(manifest.id)).toBe(manifest);
    }
    expect(getCompositionManifest("unknown-composition")).toBeUndefined();
  });

  it("describes every string prop once and in schema order", () => {
    for (const manifest of compositionManifests) {
      const schemaKeys = manifest.propsSchema.keyof().options;
      expect(manifest.fields.map((field) => field.key)).toEqual(schemaKeys);

      for (const field of manifest.fields) {
        expect(["text", "textarea"]).toContain(field.control);
        expect(Number.isInteger(field.previewFrame)).toBe(true);
        expect(field.previewFrame).toBeGreaterThanOrEqual(0);
        expect(field.previewFrame).toBeLessThan(manifest.spec.durationInFrames);
        if (field.control === "text") {
          expect("rows" in field).toBe(false);
        }
      }

      for (const frame of manifest.reviewFrames) {
        expect(Number.isInteger(frame)).toBe(true);
        expect(frame).toBeGreaterThanOrEqual(0);
        expect(frame).toBeLessThan(manifest.spec.durationInFrames);
      }
    }
  });

  it("has exactly one browser renderer for every manifest", () => {
    expect(Object.keys(browserCompositionRegistry).sort()).toEqual(
      compositionManifests.map((manifest) => manifest.id).sort(),
    );
    for (const manifest of compositionManifests) {
      expect(browserCompositionRegistry[manifest.id].manifest).toBe(manifest);
      expect(browserCompositionRegistry[manifest.id].Renderer).toBeTypeOf(
        "function",
      );
    }
  });

  it.each(compositionManifests)(
    "validates $id props at the render boundary",
    (manifest) => {
      const request = {
        compositionId: manifest.id,
        props: manifest.defaultProps,
        buildId: "build-1",
      };
      expect(parseRenderRequest(request)).toEqual(request);
      expect(() =>
        parseRenderRequest({
          ...request,
          props: { ...request.props, unexpected: "rejected" },
        }),
      ).toThrow();
      expect(() =>
        parseRenderRequest({
          compositionId: request.compositionId,
          props: request.props,
        }),
      ).toThrow();
    },
  );

  it("rejects unknown compositions", () => {
    expect(() =>
      parseRenderRequest({
        compositionId: "unknown",
        props: {},
        buildId: "build-1",
      }),
    ).toThrow("Unknown composition");
  });

  it.each(compositionManifests)(
    "revalidates $id container payloads after serialization",
    (manifest) => {
      const payload = {
        compositionId: manifest.id,
        props: manifest.defaultProps,
        buildId: "build-1",
        jobId: "0198c7d4-a5e6-7000-8000-000000000000",
        streamUpload: {
          videoId: "video-1",
          uploadUrl: "https://upload.example/video",
        },
      };
      expect(parseContainerRenderRequest(payload)).toEqual(payload);
      expect(() =>
        parseContainerRenderRequest({
          ...payload,
          props: { ...payload.props, unexpected: "rejected" },
        }),
      ).toThrow();
    },
  );
});
