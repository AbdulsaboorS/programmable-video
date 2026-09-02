import { describe, expect, it } from "vitest";

import { isAllowedRendererUrl } from "../src/browser-renderer";

const origin = "http://127.0.0.1:43123";

describe("renderer browser network isolation", () => {
  it.each([
    `${origin}/render.html`,
    `${origin}/assets/app.js`,
    "about:blank",
    "data:image/png;base64,AA==",
    "blob:http://127.0.0.1:43123/id",
  ])("allows %s", (url) => {
    expect(isAllowedRendererUrl(url, origin)).toBe(true);
  });

  it.each([
    "https://example.com/asset.png",
    "http://localhost:43123/asset.png",
    "http://127.0.0.2:43123/asset.png",
    "http://127.0.0.1:43124/asset.png",
    "https://127.0.0.1:43123/asset.png",
  ])("rejects %s", (url) => {
    expect(isAllowedRendererUrl(url, origin)).toBe(false);
  });
});
