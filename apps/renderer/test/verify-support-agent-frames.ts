import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const image = process.env.RENDERER_IMAGE ?? "programmable-video-renderer:local";
const fixturePath = fileURLToPath(
  new URL(
    "../../../compositions/support-agent/test/fixtures/linux-frame-hashes.json",
    import.meta.url,
  ),
);
const frameFixtureSchema = z.object({
  decodedPixelFormat: z.literal("rgba"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  frames: z.array(
    z.object({ frame: z.number().int().nonnegative(), sha256: z.string() }),
  ),
});
const fixture = frameFixtureSchema.parse(
  JSON.parse(await readFile(fixturePath, "utf8")),
);
const containerName = `programmable-video-frame-check-${randomUUID()}`;
const outputDirectory = await mkdtemp(join(tmpdir(), "video-frame-check-"));

try {
  await execFileAsync("docker", [
    "create",
    "--name",
    containerName,
    "--platform",
    "linux/amd64",
    image,
    "sh",
    "-lc",
    "pnpm --filter @programmable-video/renderer capture:review-stills support-agent /tmp/frames",
  ]);
  await execFileAsync("docker", ["start", "--attach", containerName], {
    maxBuffer: 8 * 1024 * 1024,
  });
  await execFileAsync("docker", [
    "cp",
    `${containerName}:/tmp/frames/.`,
    outputDirectory,
  ]);

  for (const expected of fixture.frames) {
    const path = join(outputDirectory, `${expected.frame}.png`);
    const { stdout: metadata } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        path,
      ],
      { encoding: "utf8" },
    );
    if (metadata.trim() !== `${fixture.width},${fixture.height}`) {
      throw new Error(
        `Frame ${expected.frame} has dimensions ${metadata.trim()}; expected ${fixture.width},${fixture.height}`,
      );
    }
    const { stdout: rgba } = await execFileAsync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        path,
        "-f",
        "rawvideo",
        "-pix_fmt",
        fixture.decodedPixelFormat,
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 },
    );
    const actual = createHash("sha256").update(rgba).digest("hex");
    if (actual !== expected.sha256) {
      throw new Error(
        `Frame ${expected.frame} hash ${actual} does not match ${expected.sha256}`,
      );
    }
    process.stdout.write(`support-agent frame ${expected.frame}: ${actual}\n`);
  }
} finally {
  await execFileAsync("docker", ["rm", "--force", containerName]).catch(
    () => undefined,
  );
  await rm(outputDirectory, { recursive: true, force: true });
}
