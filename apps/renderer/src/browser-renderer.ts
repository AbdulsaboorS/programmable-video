import {
  managedVideoSpecSchema,
  videoSpec,
  type ManagedVideoSpec,
} from "@programmable-video/contracts";
import type { CompositionProps } from "@programmable-video/composition-registry";
import { chromium, type Browser, type Page } from "playwright";
import { z } from "zod";

import { startStaticServer } from "./static-server";

interface TrustedVideoRendererBridge {
  version: "1";
  buildId: string;
  spec: object;
  initialize: (
    compositionId: string,
    props: CompositionProps,
  ) => Promise<object>;
  renderFrame: (frame: number) => Promise<object>;
}

interface ManagedVideoRendererBridge {
  bridgeVersion: 1;
  buildIdentity: object;
  spec: object;
  renderFrame: (frame: number) => Promise<object>;
}

declare global {
  interface Window {
    __VIDEO_RENDERER__:
      TrustedVideoRendererBridge | ManagedVideoRendererBridge | undefined;
  }
}

const trustedVideoSpecSchema = z
  .object({
    width: z.literal(videoSpec.width),
    height: z.literal(videoSpec.height),
    fps: z.literal(videoSpec.fps),
    durationInFrames: z.literal(videoSpec.durationInFrames),
  })
  .passthrough();

const trustedMetadataSchema = z
  .object({
    version: z.literal("1"),
    buildId: z.string(),
    spec: trustedVideoSpecSchema,
    initializeCallable: z.literal(true),
    renderFrameCallable: z.literal(true),
  })
  .passthrough();

const trustedAcknowledgementSchema = z
  .object({
    buildId: z.string(),
    frame: z.number().int(),
    width: z.number().int(),
    height: z.number().int(),
  })
  .passthrough();

const managedBuildIdentitySchema = z
  .object({
    commitSha: z.string(),
    buildAttempt: z.string(),
    inputDigest: z.string(),
  })
  .passthrough();

const managedMetadataSchema = z
  .object({
    bridgeVersion: z.literal(1),
    buildIdentity: managedBuildIdentitySchema,
    spec: managedVideoSpecSchema.passthrough(),
    renderFrameCallable: z.literal(true),
  })
  .passthrough();

const managedAcknowledgementSchema = z
  .object({
    bridgeVersion: z.literal(1),
    buildIdentity: managedBuildIdentitySchema,
    frame: z.number().int(),
    width: z.number().int(),
    height: z.number().int(),
  })
  .passthrough();

interface ManagedBuildIdentity {
  commitSha: string;
  buildAttempt: string;
  inputDigest: string;
}

export interface FrameSource {
  buildId: string;
  spec: ManagedVideoSpec;
  captureFrame: (frame: number) => Promise<Buffer>;
  close: () => Promise<void>;
}

export async function openBrowserRenderer(options: {
  compositionId: string;
  props: CompositionProps;
  executablePath?: string;
}): Promise<FrameSource> {
  const staticServer = await startStaticServer();
  let browser: Browser | undefined;

  try {
    browser = await launchBrowser(options.executablePath);
    const context = await createIsolatedContext(browser, staticServer.origin);
    const page = await context.newPage();
    await page.goto(`${staticServer.origin}/render.html`, {
      waitUntil: "networkidle",
    });

    const metadata = trustedMetadataSchema.parse(
      await page.evaluate(() => {
        const renderer = window.__VIDEO_RENDERER__;
        if (renderer === undefined || !("version" in renderer)) return null;
        return {
          ...renderer,
          version: renderer.version,
          buildId: renderer.buildId,
          spec: renderer.spec,
          initializeCallable: renderer.initialize instanceof Function,
          renderFrameCallable: renderer.renderFrame instanceof Function,
        };
      }),
    );
    const initialization = trustedAcknowledgementSchema.parse(
      await page.evaluate(
        ({ compositionId, props }) => {
          const renderer = window.__VIDEO_RENDERER__;
          if (renderer === undefined || !("version" in renderer)) {
            throw new Error("Trusted renderer bridge is unavailable");
          }
          return renderer.initialize(compositionId, props);
        },
        { compositionId: options.compositionId, props: options.props },
      ),
    );
    assertTrustedAcknowledgement(initialization, 0, metadata.buildId);

    return {
      buildId: metadata.buildId,
      spec: metadata.spec,
      captureFrame: async (frame) => {
        assertFrameInRange(frame, metadata.spec);
        const acknowledgement = trustedAcknowledgementSchema.parse(
          await page.evaluate((nextFrame) => {
            const renderer = window.__VIDEO_RENDERER__;
            if (renderer === undefined || !("version" in renderer)) {
              throw new Error("Trusted renderer bridge is unavailable");
            }
            return renderer.renderFrame(nextFrame);
          }, frame),
        );
        assertTrustedAcknowledgement(acknowledgement, frame, metadata.buildId);
        return capturePng(page);
      },
      close: async () => {
        await browser?.close().catch(() => undefined);
        await staticServer.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await staticServer.close().catch(() => undefined);
    throw error;
  }
}

export async function openManagedBrowserRenderer(options: {
  staticRoot: string;
  expectedIdentity: ManagedBuildIdentity;
  executablePath?: string;
}): Promise<FrameSource> {
  const staticServer = await startStaticServer(options.staticRoot);
  let browser: Browser | undefined;

  try {
    browser = await launchBrowser(options.executablePath);
    const context = await createIsolatedContext(browser, staticServer.origin);
    const page = await context.newPage();
    await page.goto(`${staticServer.origin}/render.html`, {
      waitUntil: "networkidle",
    });

    const metadata = managedMetadataSchema.parse(
      await page.evaluate(() => {
        const renderer = window.__VIDEO_RENDERER__;
        if (renderer === undefined || !("bridgeVersion" in renderer)) {
          return null;
        }
        return {
          ...renderer,
          bridgeVersion: renderer.bridgeVersion,
          buildIdentity: renderer.buildIdentity,
          spec: renderer.spec,
          renderFrameCallable: renderer.renderFrame instanceof Function,
        };
      }),
    );
    if (!identitiesMatch(metadata.buildIdentity, options.expectedIdentity)) {
      throw new Error(
        "Managed renderer build identity does not match approval",
      );
    }

    return {
      buildId: `${metadata.buildIdentity.commitSha}:${metadata.buildIdentity.buildAttempt}`,
      spec: metadata.spec,
      captureFrame: async (frame) => {
        assertFrameInRange(frame, metadata.spec);
        const acknowledgement = managedAcknowledgementSchema.parse(
          await page.evaluate((nextFrame) => {
            const renderer = window.__VIDEO_RENDERER__;
            if (renderer === undefined || !("bridgeVersion" in renderer)) {
              throw new Error("Managed renderer bridge is unavailable");
            }
            return renderer.renderFrame(nextFrame);
          }, frame),
        );
        if (
          acknowledgement.frame !== frame ||
          acknowledgement.width !== metadata.spec.width ||
          acknowledgement.height !== metadata.spec.height ||
          !identitiesMatch(
            acknowledgement.buildIdentity,
            options.expectedIdentity,
          )
        ) {
          throw new Error(
            `Managed renderer returned an invalid frame ${frame}`,
          );
        }
        return capturePng(page);
      },
      close: async () => {
        await browser?.close().catch(() => undefined);
        await staticServer.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await staticServer.close().catch(() => undefined);
    throw error;
  }
}

async function launchBrowser(executablePath: string | undefined) {
  if (executablePath === undefined) {
    return chromium.launch({ headless: true });
  }
  return chromium.launch({ headless: true, executablePath });
}

async function createIsolatedContext(browser: Browser, staticOrigin: string) {
  const context = await browser.newContext({
    viewport: { width: videoSpec.width, height: videoSpec.height },
    screen: { width: videoSpec.width, height: videoSpec.height },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  await context.route("**/*", async (route) => {
    if (isAllowedRendererUrl(route.request().url(), staticOrigin)) {
      await route.continue();
    } else {
      await route.abort("blockedbyclient");
    }
  });
  await context.routeWebSocket("**/*", (socket) =>
    socket.close({ code: 1008, reason: "WebSockets are disabled" }),
  );
  return context;
}

function assertFrameInRange(frame: number, spec: ManagedVideoSpec): void {
  if (!Number.isInteger(frame) || frame < 0 || frame >= spec.durationInFrames) {
    throw new RangeError(
      `Frame must be an integer from 0 to ${spec.durationInFrames - 1}`,
    );
  }
}

function assertTrustedAcknowledgement(
  acknowledgement: z.infer<typeof trustedAcknowledgementSchema>,
  frame: number,
  buildId: string,
): void {
  if (
    acknowledgement.frame !== frame ||
    acknowledgement.width !== videoSpec.width ||
    acknowledgement.height !== videoSpec.height ||
    acknowledgement.buildId !== buildId
  ) {
    throw new Error(
      `Renderer returned an invalid acknowledgement for frame ${frame}`,
    );
  }
}

function identitiesMatch(
  actual: ManagedBuildIdentity,
  expected: ManagedBuildIdentity,
): boolean {
  return (
    actual.commitSha === expected.commitSha &&
    actual.buildAttempt === expected.buildAttempt &&
    actual.inputDigest === expected.inputDigest
  );
}

function capturePng(page: Page): Promise<Buffer> {
  return page.screenshot({
    type: "png",
    animations: "disabled",
    caret: "hide",
    scale: "css",
  });
}

export function isAllowedRendererUrl(
  value: string,
  staticOrigin: string,
): boolean {
  const url = new URL(value);
  if (["about:", "blob:", "data:"].includes(url.protocol)) return true;
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin === new URL(staticOrigin).origin
  );
}
