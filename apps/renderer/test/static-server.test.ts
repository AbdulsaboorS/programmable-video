import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startStaticServer } from "../src/static-server";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("static render server", () => {
  it("serves render.html without caching", async () => {
    const directory = await mkdtemp(join(tmpdir(), "renderer-static-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "render.html"), "<main>render</main>");
    const server = await startStaticServer(directory);

    try {
      const response = await fetch(`${server.origin}/render.html`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("<main>render</main>");
    } finally {
      await server.close();
    }
  });

  it("does not serve files outside the static root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "renderer-static-"));
    temporaryDirectories.push(directory);
    const server = await startStaticServer(directory);

    try {
      const response = await fetch(`${server.origin}/..%2Fsecret`);
      expect(response.status).toBe(403);
    } finally {
      await server.close();
    }
  });
});
