import type { WorkflowStep } from "cloudflare:workers";

import {
  recordCaptionState,
  recordDownloadState,
  type PublicationWorkflowTarget,
} from "./managed-publications";
import {
  createProjectMediaCapability,
  getProjectMediaByCapability,
} from "./project-media";
import { streamPollInterval } from "./worker-constants";
import { publicationStreamService } from "./stream-service";

export async function deliverCaptions(
  target: PublicationWorkflowTarget,
  videoId: string,
  step: WorkflowStep,
  env: Env,
): Promise<void> {
  const captions = target.finishingSpec.captions;
  if (captions.mode === "none" || target.captionStatus === "ready") return;
  await step.do("mark captions processing", async () =>
    recordCaptionState(target.attemptId, "processing", null, env.PROJECTS_DB),
  );
  const handle = publicationStreamService(env).video(videoId).captions;
  if (captions.mode === "uploaded") {
    await step.do("upload English captions", async () => {
      const existing = (await handle.list("en").catch(() => []))[0];
      if (
        existing &&
        existing.generated !== true &&
        existing.status !== "error"
      )
        return;
      if (existing) await handle.delete("en");
      const token = await createProjectMediaCapability(
        target.projectId,
        captions.asset.id,
        target.publicationId,
        target.attemptId,
        target.ownerEmail,
        env,
      );
      if (!token) throw new Error("Uploaded captions are unavailable");
      const response = await getProjectMediaByCapability(
        captions.asset.id,
        token,
        env,
      );
      if (!response.ok || !response.body)
        throw new Error("Uploaded captions could not be loaded");
      await handle.upload("en", response.body);
    });
    for (let poll = 0; poll < 240; poll += 1) {
      const caption = await step.do(
        `check uploaded captions ${poll}`,
        async () => (await handle.list("en"))[0],
      );
      if (caption?.generated === true)
        throw new Error("Stream English captions do not match the upload");
      if (caption?.status === "ready") {
        await step.do("record uploaded captions ready", async () =>
          recordCaptionState(target.attemptId, "ready", null, env.PROJECTS_DB),
        );
        return;
      }
      if (caption?.status === "error")
        throw new Error("Stream could not process uploaded English captions");
      await step.sleep(
        `wait for uploaded captions ${poll}`,
        streamPollInterval,
      );
    }
    throw new Error("Uploaded caption processing deadline exceeded");
  }

  await step.do("request generated English captions", async () => {
    const existing = (await handle.list("en").catch(() => []))[0];
    const replace =
      existing && (existing.generated !== true || existing.status === "error");
    if (replace) await handle.delete("en");
    if (!existing || replace) await handle.generate("en");
  });
  for (let poll = 0; poll < 240; poll += 1) {
    const caption = await step.do(
      `check generated captions ${poll}`,
      async () => (await handle.list("en"))[0],
    );
    if (caption?.generated === true && caption.status === "ready") {
      await step.do("record generated captions ready", async () =>
        recordCaptionState(target.attemptId, "ready", null, env.PROJECTS_DB),
      );
      return;
    }
    if (caption && caption.generated !== true)
      throw new Error(
        "Stream English captions do not match the generation request",
      );
    if (caption?.status === "error")
      throw new Error("Stream could not generate English captions");
    await step.sleep(`wait for generated captions ${poll}`, streamPollInterval);
  }
  throw new Error("Generated caption processing deadline exceeded");
}

export async function deliverDownload(
  target: PublicationWorkflowTarget,
  videoId: string,
  step: WorkflowStep,
  env: Env,
): Promise<void> {
  if (target.downloadStatus === "ready") return;
  const downloads = publicationStreamService(env).video(videoId).downloads;
  await step.do("request default MP4 download", async () => {
    const existing = (
      await downloads.get().catch(() => ({ default: undefined }))
    ).default;
    if (existing?.status === "error") await downloads.delete("default");
    if (!existing || existing.status === "error")
      await downloads.generate("default");
  });
  for (let poll = 0; poll < 240; poll += 1) {
    const download = await step.do(
      `check default MP4 download ${poll}`,
      async () => (await downloads.get()).default,
    );
    if (download?.status === "ready") {
      if (!download.url)
        throw new Error("Stream download is ready without a URL");
      const downloadUrl = download.url;
      await step.do("record default MP4 ready", async () =>
        recordDownloadState(
          target.attemptId,
          { status: "ready", percent: 100, url: downloadUrl },
          env.PROJECTS_DB,
        ),
      );
      return;
    }
    if (download?.status === "error")
      throw new Error("Stream could not generate the MP4 download");
    await step.do(`record default MP4 progress ${poll}`, async () =>
      recordDownloadState(
        target.attemptId,
        { status: "processing", percent: download?.percentComplete ?? null },
        env.PROJECTS_DB,
      ),
    );
    await step.sleep(
      `wait for default MP4 download ${poll}`,
      streamPollInterval,
    );
  }
  throw new Error("MP4 download processing deadline exceeded");
}
