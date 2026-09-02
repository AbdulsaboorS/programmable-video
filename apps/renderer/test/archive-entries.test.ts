import { describe, expect, it } from "vitest";

import { assertSafeArchiveEntries } from "../src/archive-entries";

describe("managed artifact archive entries", () => {
  it("accepts a tar root marker and relative build files", () => {
    expect(() =>
      assertSafeArchiveEntries(
        "./\n./index.html\n./render.html\n./assets/render.js\n",
      ),
    ).not.toThrow();
  });

  it.each(["../secret", "./assets/../../secret", "/etc/passwd", "."])(
    "rejects unsafe entry %s",
    (entry) => {
      expect(() => assertSafeArchiveEntries(`${entry}\n`)).toThrow(
        "Approved artifact archive contains an unsafe path",
      );
    },
  );
});
