import { videoSpec } from "@programmable-video/contracts";
import { parseCompositionProps } from "@programmable-video/composition-registry";
import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { openBrowserRenderer } from "./browser-renderer";
import type { JsonValue } from "./json-value";

export interface CaptureStillOptions {
  compositionId: string;
  props: JsonValue;
  frame: number;
  outputPath: string;
  executablePath?: string;
}

export interface CapturedStill {
  outputPath: string;
  buildId: string;
  frame: number;
  format: "png";
  width: number;
  height: number;
}

export async function captureStill(
  options: CaptureStillOptions,
): Promise<CapturedStill> {
  const { compositionId, props } = parseCompositionProps(
    options.compositionId,
    options.props,
  );
  if (
    !Number.isInteger(options.frame) ||
    options.frame < 0 ||
    options.frame >= videoSpec.durationInFrames
  ) {
    throw new RangeError(
      `Frame must be an integer from 0 to ${videoSpec.durationInFrames - 1}`,
    );
  }

  const outputPath = resolve(options.outputPath);
  const temporaryPath = `${outputPath}.tmp-${randomUUID()}.png`;
  await mkdir(dirname(outputPath), { recursive: true });
  const rendererOptions: Parameters<typeof openBrowserRenderer>[0] = {
    compositionId,
    props,
  };
  if (options.executablePath !== undefined) {
    rendererOptions.executablePath = options.executablePath;
  }
  const renderer = await openBrowserRenderer(rendererOptions);
  let completed = false;

  try {
    const png = await renderer.captureFrame(options.frame);
    await writeFile(temporaryPath, png);
    await rename(temporaryPath, outputPath);
    completed = true;
    return {
      outputPath,
      buildId: renderer.buildId,
      frame: options.frame,
      format: "png",
      width: videoSpec.width,
      height: videoSpec.height,
    };
  } finally {
    await renderer.close();
    if (!completed) await unlink(temporaryPath).catch(() => undefined);
  }
}
