import { getCompositionManifest } from "@programmable-video/composition-registry";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { openBrowserRenderer } from "./browser-renderer";

const compositionId = process.argv[2];
const outputDirectory = process.argv[3];
if (compositionId === undefined || outputDirectory === undefined) {
  throw new Error(
    "Usage: capture-review-stills <composition-id> <output-directory>",
  );
}
const manifest = getCompositionManifest(compositionId);
if (manifest === undefined) {
  throw new Error(`Unknown composition: ${compositionId}`);
}

const resolvedOutput = resolve(outputDirectory);
await mkdir(resolvedOutput, { recursive: true });
const renderer = await openBrowserRenderer({
  compositionId: manifest.id,
  props: manifest.defaultProps,
});

try {
  for (const frame of manifest.reviewFrames) {
    const png = await renderer.captureFrame(frame);
    await writeFile(`${resolvedOutput}/${frame}.png`, png);
  }
} finally {
  await renderer.close();
}
