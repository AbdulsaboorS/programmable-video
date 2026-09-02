import { getCompositionManifest } from "@programmable-video/composition-registry";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  openBrowserRenderer,
  openManagedBrowserRenderer,
} from "../src/browser-renderer";

interface ManagedIdentity {
  commitSha: string;
  buildAttempt: string;
  inputDigest: string;
}

interface ProbeServer {
  url: string;
  webSocketUrl: string;
  requestCount: () => number;
  upgradeCount: () => number;
  resetRequestCount: () => void;
  close: () => Promise<void>;
}

const execFileAsync = promisify(execFile);
const supportAgentManifest = getCompositionManifest("support-agent");
if (supportAgentManifest === undefined) {
  throw new Error("support-agent must be registered");
}
const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const renderHtml = fileURLToPath(
  new URL("../../studio/dist/render.html", import.meta.url),
);
const managedIdentity: ManagedIdentity = {
  commitSha: "a".repeat(40),
  buildAttempt: "2",
  inputDigest: "b".repeat(64),
};

async function startProbeServer(): Promise<ProbeServer> {
  let requests = 0;
  let upgrades = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("reachable");
  });
  server.on("upgrade", (_request, socket) => {
    upgrades += 1;
    socket.destroy();
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address());

  return {
    url: `http://127.0.0.1:${address.port}/frame-capture-probe`,
    webSocketUrl: `ws://127.0.0.1:${address.port}/frame-capture-probe`,
    requestCount: () => requests,
    upgradeCount: () => upgrades,
    resetRequestCount: () => {
      requests = 0;
    },
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((error) => {
          if (error === undefined) resolvePromise();
          else reject(error);
        });
      }),
  };
}

async function createManagedFixture(
  durationInFrames: number,
  probeUrl: string | null = null,
  acknowledgementWidth = 1280,
  buildIdentity: ManagedIdentity = managedIdentity,
  acknowledgementIdentity: ManagedIdentity = buildIdentity,
  renderFrameCallable = true,
  webSocketUrl: string | null = null,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "managed-video-renderer-"));
  const spec = {
    width: 1280,
    height: 720,
    fps: 30,
    durationInFrames,
    futureSpecField: "allowed",
  };
  const reorderedIdentity = {
    inputDigest: buildIdentity.inputDigest,
    commitSha: buildIdentity.commitSha,
    buildAttempt: buildIdentity.buildAttempt,
  };
  const renderFrame = renderFrameCallable
    ? `async renderFrame(frame) {
    const probeUrl = ${JSON.stringify(probeUrl)};
    let networkBlocked = probeUrl === null;
    if (probeUrl !== null) {
      try {
        await fetch(probeUrl);
      } catch {
        networkBlocked = true;
      }
    }
    const webSocketUrl = ${JSON.stringify(webSocketUrl)};
    if (webSocketUrl !== null) {
      await new Promise((resolve) => {
        const socket = new WebSocket(webSocketUrl);
        socket.addEventListener("close", resolve, { once: true });
        socket.addEventListener("error", resolve, { once: true });
      });
    }
    document.querySelector("#frame").textContent = String(frame);
    document.body.style.backgroundColor = frame % 2 === 0 ? "rgb(12, 34, 56)" : "rgb(210, 120, 30)";
    return {
      bridgeVersion: 1,
      buildIdentity: ${JSON.stringify(acknowledgementIdentity)},
      frame,
      width: networkBlocked ? ${acknowledgementWidth} : 0,
      height: 720,
      futureAcknowledgementField: "allowed"
    };
  }`
    : "renderFrame: null";
  await writeFile(
    join(root, "render.html"),
    `<!doctype html>
<html><body><main id="frame"></main><script>
const buildIdentity = ${JSON.stringify(reorderedIdentity)};
window.__VIDEO_RENDERER__ = {
  bridgeVersion: 1,
  buildIdentity,
  spec: ${JSON.stringify(spec)},
  futureMetadataField: "allowed",
  ${renderFrame}
};
</script></body></html>`,
  );
  return root;
}

beforeAll(async () => {
  try {
    await access(renderHtml);
  } catch {
    await execFileAsync(
      "pnpm",
      ["--filter", "@programmable-video/studio", "build"],
      { cwd: workspaceRoot },
    );
  }
});

describe("browser network isolation integration", () => {
  it("captures trusted frames through the FrameSource boundary", async () => {
    const renderer = await openBrowserRenderer({
      compositionId: "support-agent",
      props: supportAgentManifest.defaultProps,
    });

    try {
      const png = await renderer.captureFrame(0);
      expect(png.subarray(1, 4).toString()).toBe("PNG");
    } finally {
      await renderer.close();
    }
  }, 60_000);

  it("blocks a reachable second origin without sending it a request", async () => {
    const probeServer = await startProbeServer();
    try {
      const nodeResponse = await fetch(probeServer.url);
      expect(await nodeResponse.text()).toBe("reachable");
      expect(probeServer.requestCount()).toBe(1);
      probeServer.resetRequestCount();

      const staticRoot = await createManagedFixture(450, probeServer.url);
      try {
        const renderer = await openManagedBrowserRenderer({
          staticRoot,
          expectedIdentity: managedIdentity,
        });
        try {
          await renderer.captureFrame(0);
          expect(probeServer.requestCount()).toBe(0);
        } finally {
          await renderer.close();
        }
      } finally {
        await rm(staticRoot, { recursive: true, force: true });
      }
    } finally {
      await probeServer.close();
    }
  }, 60_000);

  it("blocks WebSockets before a reachable server receives an upgrade", async () => {
    const probeServer = await startProbeServer();
    try {
      const nodeResponse = await fetch(probeServer.url);
      expect(await nodeResponse.text()).toBe("reachable");

      const staticRoot = await createManagedFixture(
        450,
        null,
        1280,
        managedIdentity,
        managedIdentity,
        true,
        probeServer.webSocketUrl,
      );
      try {
        const renderer = await openManagedBrowserRenderer({
          staticRoot,
          expectedIdentity: managedIdentity,
        });
        try {
          await renderer.captureFrame(0);
          expect(probeServer.upgradeCount()).toBe(0);
        } finally {
          await renderer.close();
        }
      } finally {
        await rm(staticRoot, { recursive: true, force: true });
      }
    } finally {
      await probeServer.close();
    }
  }, 60_000);

  it("captures distinct frames deterministically", async () => {
    const staticRoot = await createManagedFixture(450);
    try {
      const renderer = await openManagedBrowserRenderer({
        staticRoot,
        expectedIdentity: managedIdentity,
      });
      try {
        const first = await renderer.captureFrame(1);
        const second = await renderer.captureFrame(2);
        const repeated = await renderer.captureFrame(1);
        expect(first.equals(second)).toBe(false);
        expect(first.equals(repeated)).toBe(true);
        await expect(renderer.captureFrame(450)).rejects.toThrow(RangeError);
      } finally {
        await renderer.close();
      }
    } finally {
      await rm(staticRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it.each([
    ["commitSha", { ...managedIdentity, commitSha: "c".repeat(40) }],
    ["buildAttempt", { ...managedIdentity, buildAttempt: "3" }],
    ["inputDigest", { ...managedIdentity, inputDigest: "d".repeat(64) }],
  ])(
    "rejects a mismatched managed %s while opening",
    async (_field, expected) => {
      const staticRoot = await createManagedFixture(450);
      try {
        await expect(
          openManagedBrowserRenderer({
            staticRoot,
            expectedIdentity: expected,
          }),
        ).rejects.toThrow(
          "Managed renderer build identity does not match approval",
        );
      } finally {
        await rm(staticRoot, { recursive: true, force: true });
      }
    },
  );

  it("rejects an acknowledgement identity mismatch", async () => {
    const acknowledgementIdentity = {
      ...managedIdentity,
      inputDigest: "d".repeat(64),
    };
    const staticRoot = await createManagedFixture(
      450,
      null,
      1280,
      managedIdentity,
      acknowledgementIdentity,
    );
    try {
      const renderer = await openManagedBrowserRenderer({
        staticRoot,
        expectedIdentity: managedIdentity,
      });
      try {
        await expect(renderer.captureFrame(0)).rejects.toThrow(
          "Managed renderer returned an invalid frame 0",
        );
      } finally {
        await renderer.close();
      }
    } finally {
      await rm(staticRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects an invalid managed frame acknowledgement", async () => {
    const staticRoot = await createManagedFixture(450, null, 1279);
    try {
      const renderer = await openManagedBrowserRenderer({
        staticRoot,
        expectedIdentity: managedIdentity,
      });
      try {
        await expect(renderer.captureFrame(0)).rejects.toThrow(
          "Managed renderer returned an invalid frame 0",
        );
      } finally {
        await renderer.close();
      }
    } finally {
      await rm(staticRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects a malformed managed render method while opening", async () => {
    const staticRoot = await createManagedFixture(
      450,
      null,
      1280,
      managedIdentity,
      managedIdentity,
      false,
    );
    try {
      await expect(
        openManagedBrowserRenderer({
          staticRoot,
          expectedIdentity: managedIdentity,
        }),
      ).rejects.toThrow();
    } finally {
      await rm(staticRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects an unsupported managed bridge specification", async () => {
    const staticRoot = await createManagedFixture(451);
    try {
      await expect(
        openManagedBrowserRenderer({
          staticRoot,
          expectedIdentity: managedIdentity,
        }),
      ).rejects.toThrow();
    } finally {
      await rm(staticRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
