import { Container, getContainer } from "@cloudflare/containers";
import { getSandbox } from "@cloudflare/sandbox";
export { Sandbox } from "@cloudflare/sandbox";
import {
  managedContainerRenderRequestSchema,
  projectMediaAssetSchema,
  revisionArtifactManifestSchema,
  rendererErrorResponseSchema,
  type RevisionSubmissionWorkflowCommand,
  type RenderStatus,
} from "@programmable-video/contracts";
import {
  parseContainerRenderRequest,
  parseRenderRequest,
  type RenderRequest,
} from "@programmable-video/composition-registry";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

import { mapWorkflowStatus, withWorkflowFailure } from "./status";
import { createRender, getRender } from "./api";
import { accessEmail } from "./access";
import {
  finishRevisionInspection,
  getRevisionSourceProvenance,
  listProjectRevisions,
  loadPendingRevisionTarget,
  loadRevisionTarget,
  revisionErrorFinding,
  submitRevisionBundle,
} from "./revisions";
import {
  createHandoff,
  createProjectFeedback,
  createProject,
  getProject,
  listProjects,
  saveProjectBrief,
} from "./projects";
import {
  createReferenceUpload,
  getReferenceByCapability,
  getReferenceContent,
} from "./project-references";
import { buildRevision, inspectBundledRevision } from "./revision-builds";
import {
  claimRevisionBuild,
  completeRevisionBuild,
  expireStaleRevisionBuild,
  failQueuedRevisionBuild,
  listStaleRevisionBuilds,
  queueInitialRevisionBuild,
  requestRevisionBuildRetry,
  revisionSandboxId,
  type RevisionBuildRetryCommand,
} from "./revision-build-lifecycle";
import {
  approveRevision,
  containerArtifactUrl,
  createPreviewSession,
} from "./revision-delivery";
import {
  completePublicationAttempt,
  createManagedPublication,
  failPublicationAttempt,
  getManagedPublication,
  listManagedPublications,
  loadPublicationWorkflowTarget,
  markPublicationRendering,
  recordCaptionState,
  recordDownloadState,
  recordPlaybackReady,
  retryManagedPublication,
  reservePublicationStreamUpload,
} from "./managed-publications";
import { deliverCaptions, deliverDownload } from "./publication-delivery";
import {
  createProjectMediaCapability,
  createProjectMediaUpload,
  getProjectMediaByCapability,
  getProjectMediaContent,
  getProjectMediaMetadata,
  listProjectMedia,
  projectMediaCapabilityUrl,
  validateProjectAudioWithRenderer,
} from "./project-media";
import {
  signPreviewCapability,
  type PreviewCapability,
} from "./preview-capability";
import { streamPollInterval } from "./worker-constants";
import { publicationStreamService } from "./stream-service";
import type { BoundaryError } from "./worker-utils";

const streamDeadlineMs = 20 * 60 * 1000;
const revisionQueuePollInterval = "30 seconds";
const revisionQueuePollLimit = 240;

type RenderWorkflowParams = RenderRequest;

interface RendererEnvironmentVariables {
  [name: string]: string;
}

export class RendererContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  envVars: RendererEnvironmentVariables = {
    CONTAINER_EXTRA_CA_CERT: this.env.CONTAINER_EXTRA_CA_CERT ?? "",
  };
}

export class RenderWorkflow extends WorkflowEntrypoint<
  Env,
  RenderWorkflowParams
> {
  async run(
    event: WorkflowEvent<RenderWorkflowParams>,
    step: WorkflowStep,
  ): Promise<RenderStatus> {
    const stream = publicationStreamService(this.env);
    const payload = await withWorkflowFailure("validation", async () =>
      parseRenderRequest(event.payload),
    );
    const upload = await withWorkflowFailure("upload", () =>
      step.do(
        "create Stream upload",
        { retries: { limit: 0, delay: "1 second" } },
        async () => {
          const directUpload = await stream.createDirectUpload({
            maxDurationSeconds: 12,
            meta: {
              buildId: payload.buildId,
              compositionId: payload.compositionId,
              jobId: event.instanceId,
              source: "programmable-video-studio",
            },
          });
          return {
            videoId: directUpload.id,
            uploadUrl: directUpload.uploadURL,
            deadlineAt: Date.now() + streamDeadlineMs,
          };
        },
      ),
    );

    await withWorkflowFailure("render", () =>
      step.do(
        "render and upload video",
        { retries: { limit: 0, delay: "1 second" }, timeout: "25 minutes" },
        async () => {
          const renderer = getContainer(this.env.RENDERER, event.instanceId);
          const containerPayload = parseContainerRenderRequest({
            ...payload,
            jobId: event.instanceId,
            streamUpload: {
              videoId: upload.videoId,
              uploadUrl: upload.uploadUrl,
            },
          });
          const response = await renderer.fetch(
            new Request("http://renderer/render", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(containerPayload),
            }),
          );
          if (!response.ok) {
            const failure = rendererErrorResponseSchema.safeParse(
              await response.json().catch(() => undefined),
            );
            if (failure.success) {
              throw new Error(
                `[${failure.data.error.stage}] ${failure.data.error.message}`,
              );
            }
            throw new Error(`Renderer returned HTTP ${response.status}`);
          }
          await response.body?.cancel();
        },
      ),
    );

    return withWorkflowFailure("processing", async () => {
      for (let attempt = 0; Date.now() < upload.deadlineAt; attempt += 1) {
        const video = await step.do(
          `check Stream status ${attempt}`,
          async () => {
            return stream.video(upload.videoId).details();
          },
        );
        if (video.readyToStream && video.preview) {
          return {
            status: "ready",
            videoId: video.id,
            previewUrl: video.preview,
            hlsUrl: video.hlsPlaybackUrl,
            thumbnailUrl: video.thumbnail,
          };
        }
        if (video.status.state === "error") {
          throw new Error("Stream could not process the rendered video");
        }
        await step.sleep(`wait for Stream ${attempt}`, streamPollInterval);
      }
      throw new Error("Stream processing deadline exceeded");
    });
  }
}

export class ManagedRenderWorkflow extends WorkflowEntrypoint<
  Env,
  { attemptId: string } | { jobId: string }
> {
  async run(
    event: WorkflowEvent<{ attemptId: string } | { jobId: string }>,
    step: WorkflowStep,
  ): Promise<void> {
    const stream = publicationStreamService(this.env);
    const attemptId =
      "attemptId" in event.payload
        ? event.payload.attemptId
        : event.payload.jobId;
    try {
      let target = await step.do("load publication attempt", async () =>
        loadPublicationWorkflowTarget(attemptId, this.env.PROJECTS_DB),
      );
      await step.do("mark publication running", async () =>
        markPublicationRendering(target.attemptId, this.env.PROJECTS_DB),
      );
      let videoId = target.streamVideoId;
      if (target.playbackStatus !== "ready") {
        const manifest = await step.do("load approved manifest", async () => {
          const object = await this.env.REVISION_PREVIEWS.get(
            `${target.previewPrefix}/manifest.json`,
          );
          if (!object) throw new Error("Approved revision manifest is missing");
          const bytes = new Uint8Array(await object.arrayBuffer());
          if ((await sha256(bytes)) !== target.manifestDigest)
            throw new Error("Approved revision manifest digest does not match");
          const parsed = revisionArtifactManifestSchema.parse(
            JSON.parse(new TextDecoder().decode(bytes)),
          );
          if (
            parsed.projectId !== target.projectId ||
            parsed.revisionId !== target.revisionId ||
            parsed.commitSha !== target.commitSha ||
            parsed.attempt !== target.buildAttempt ||
            parsed.inputDigest !== target.inputDigest
          ) {
            throw new Error(
              "Approved revision manifest identity does not match",
            );
          }
          return parsed;
        });
        const upload = await step.do(
          "reserve managed Stream upload",
          { retries: { limit: 0, delay: "1 second" } },
          async () => {
            return reservePublicationStreamUpload(
              target,
              stream,
              this.env.PROJECTS_DB,
            );
          },
        );
        videoId = upload.videoId;
        await step.do(
          "render managed publication",
          { retries: { limit: 0, delay: "1 second" }, timeout: "25 minutes" },
          async () => {
            const capability: PreviewCapability = {
              version: 1,
              projectId: target.projectId,
              revisionId: target.revisionId,
              commitSha: target.commitSha,
              attempt: target.buildAttempt,
              prefix: target.previewPrefix,
              manifestDigest: target.manifestDigest,
              owner: target.ownerEmail,
              expiresAt: Math.floor(Date.now() / 1_000) + 30 * 60,
            };
            const artifactToken = await signPreviewCapability(
              capability,
              this.env.PREVIEW_SIGNING_KEY,
            );
            const audioCapability = target.finishingSpec.audio
              ? await publicationAudioCapability(target, this.env)
              : undefined;
            const payloadInput = {
              kind: "managed-revision",
              jobId: target.attemptId,
              manifest,
              manifestDigest: target.manifestDigest,
              artifactUrl: containerArtifactUrl(
                this.env.PREVIEW_ORIGIN,
                target.revisionId,
              ),
              artifactToken,
              finishingSpec: target.finishingSpec,
              streamUpload: {
                videoId: upload.videoId,
                uploadUrl: upload.uploadUrl,
              },
            };
            if (audioCapability) {
              Object.assign(payloadInput, { audioCapability });
            }
            const payload =
              managedContainerRenderRequestSchema.parse(payloadInput);
            const response = await getContainer(
              this.env.RENDERER,
              target.attemptId,
            ).fetch(
              new Request("http://renderer/render-managed", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
              }),
            );
            if (!response.ok) {
              const failure = rendererErrorResponseSchema.safeParse(
                await response.json().catch(() => undefined),
              );
              throw new Error(
                failure.success
                  ? `[${failure.data.error.stage}] ${failure.data.error.message}`
                  : `Renderer returned HTTP ${response.status}`,
              );
            }
            await response.body?.cancel();
          },
        );
        for (let poll = 0; poll < 240; poll += 1) {
          const video = await step.do(
            `check managed Stream status ${poll}`,
            async () => stream.video(upload.videoId).details(),
          );
          if (video.readyToStream && video.preview) {
            await step.do("record managed playback", async () =>
              recordPlaybackReady(
                target.attemptId,
                {
                  videoId: video.id,
                  playerUrl: video.preview!,
                  hlsUrl: video.hlsPlaybackUrl,
                  thumbnailUrl: video.thumbnail || null,
                },
                this.env.PROJECTS_DB,
              ),
            );
            target = {
              ...target,
              playbackStatus: "ready",
              streamVideoId: video.id,
              playerUrl: video.preview,
              hlsUrl: video.hlsPlaybackUrl,
              thumbnailUrl: video.thumbnail || null,
            };
            break;
          }
          if (video.status.state === "error")
            throw new Error("Stream could not process the managed video");
          await step.sleep(
            `wait for managed Stream ${poll}`,
            streamPollInterval,
          );
        }
        if (target.playbackStatus !== "ready")
          throw new Error("Stream processing deadline exceeded");
      }
      if (!videoId) throw new Error("Publication Stream video is unavailable");

      try {
        await deliverCaptions(target, videoId, step, this.env);
      } catch (error) {
        await recordCaptionState(
          target.attemptId,
          "failed",
          safeWorkflowError(error),
          this.env.PROJECTS_DB,
        );
      }
      try {
        await deliverDownload(target, videoId, step, this.env);
      } catch (error) {
        await recordDownloadState(
          target.attemptId,
          { status: "failed", error: safeWorkflowError(error) },
          this.env.PROJECTS_DB,
        );
      }
      await step.do("complete publication attempt", async () =>
        completePublicationAttempt(target.attemptId, this.env.PROJECTS_DB),
      );
    } catch (error) {
      await failPublicationAttempt(
        attemptId,
        safeWorkflowError(error),
        this.env.PROJECTS_DB,
      );
      throw error;
    }
  }
}

export class RevisionWorkflow extends WorkflowEntrypoint<
  Env,
  RevisionBuildRetryCommand | RevisionSubmissionWorkflowCommand
> {
  async run(
    event: WorkflowEvent<
      RevisionBuildRetryCommand | RevisionSubmissionWorkflowCommand
    >,
    step: WorkflowStep,
  ): Promise<void> {
    if (event.payload.kind === "submitted-revision") {
      const command = event.payload;
      const target = await step.do("load submitted revision", async () =>
        loadPendingRevisionTarget(
          command.revisionId,
          command.projectId,
          this.env.PROJECTS_DB,
        ),
      );
      if (!target) return;
      let status = target.inspectionStatus;
      if (status === "pending" || status === "error") {
        let inspected;
        try {
          inspected = await step.do(
            "inspect submitted revision",
            { retries: { limit: 2, delay: "5 seconds" }, timeout: "5 minutes" },
            async () => inspectBundledRevision(target, this.env),
          );
        } catch {
          inspected = {
            inspection: {
              status: "error" as const,
              findings: [revisionErrorFinding()],
            },
          };
        }
        const recorded = await step.do(
          "record submitted revision inspection",
          async () =>
            finishRevisionInspection(
              target.id,
              inspected.inspection,
              this.env.PROJECTS_DB,
              inspected.sourceProvenance,
            ),
        );
        if (!recorded) return;
        status = inspected.inspection.status;
      }
      if (status !== "valid") return;
      const queued = await step.do("queue initial revision build", async () =>
        queueInitialRevisionBuild(target.id, this.env.PROJECTS_DB),
      );
      if (!queued) return;
      await this.runBuild(target, queued.attempt, event.instanceId, step);
      return;
    }
    const command = event.payload;
    const target = await step.do("load retry revision", async () =>
      loadRevisionTarget(command.revisionId, this.env.PROJECTS_DB),
    );
    if (!target || target.projectId !== command.projectId) return;
    await this.runBuild(target, command.attempt, event.instanceId, step);
  }

  private async runBuild(
    target: Parameters<typeof buildRevision>[0],
    attempt: number,
    leaseOwner: string,
    step: WorkflowStep,
  ): Promise<void> {
    for (let poll = 0; poll < revisionQueuePollLimit; poll += 1) {
      const staleBuilds = await step.do(
        `find stale revision builds ${poll}`,
        async () => listStaleRevisionBuilds(this.env.PROJECTS_DB),
      );
      for (const [index, stale] of staleBuilds.entries()) {
        await step.do(
          `destroy stale revision sandbox ${poll}-${index}`,
          { retries: { limit: 3, delay: "10 seconds" } },
          async () =>
            getSandbox(
              this.env.SANDBOX,
              revisionSandboxId(stale.revisionId, stale.attempt),
            ).destroy(),
        );
        await step.do(
          `expire stale revision build ${poll}-${index}`,
          async () => expireStaleRevisionBuild(stale, this.env.PROJECTS_DB),
        );
      }
      const claim = await step.do(`claim revision build ${poll}`, async () =>
        claimRevisionBuild(
          target.id,
          attempt,
          leaseOwner,
          this.env.PROJECTS_DB,
        ),
      );
      if (claim.kind === "unavailable") return;
      if (claim.kind === "claimed") {
        try {
          await step.do(
            "build exact revision",
            {
              retries: { limit: 0, delay: "1 second" },
              timeout: "30 minutes",
            },
            async () =>
              buildRevision(
                target,
                attempt,
                leaseOwner,
                claim.createdAt,
                this.env,
              ),
          );
        } catch (error) {
          await step.do(
            "destroy failed revision sandbox",
            { retries: { limit: 3, delay: "10 seconds" } },
            async () =>
              getSandbox(
                this.env.SANDBOX,
                revisionSandboxId(target.id, attempt),
              ).destroy(),
          );
          await step.do("record failed revision build", async () =>
            completeRevisionBuild(
              target.id,
              attempt,
              leaseOwner,
              "error",
              [],
              { errorMessage: "The build worker could not complete" },
              this.env.PROJECTS_DB,
            ),
          );
          throw error;
        }
        return;
      }
      await step.sleep(
        `wait for revision capacity ${poll}`,
        revisionQueuePollInterval,
      );
    }
    await step.do("expire queued revision build", async () =>
      failQueuedRevisionBuild(
        target.id,
        attempt,
        "The preview build waited too long for capacity",
        this.env.PROJECTS_DB,
      ),
    );
  }
}

async function publicationAudioCapability(
  target: Awaited<ReturnType<typeof loadPublicationWorkflowTarget>>,
  env: Env,
) {
  const audio = target.finishingSpec.audio;
  if (!audio) return undefined;
  const token = await createProjectMediaCapability(
    target.projectId,
    audio.asset.id,
    target.publicationId,
    target.attemptId,
    target.ownerEmail,
    env,
  );
  if (!token) throw new Error("Publication audio is unavailable");
  const metadataResponse = await getProjectMediaMetadata(
    target.projectId,
    audio.asset.id,
    target.ownerEmail,
    env,
  );
  if (!metadataResponse.ok)
    throw new Error("Publication audio metadata is unavailable");
  const metadata = projectMediaAssetSchema.parse(await metadataResponse.json());
  if (metadata.kind !== "audio" || metadata.sha256 !== audio.asset.sha256) {
    throw new Error("Publication audio identity does not match");
  }
  return {
    url: projectMediaCapabilityUrl(metadata.id, env.STUDIO_ORIGIN),
    token,
    sha256: metadata.sha256,
    byteSize: metadata.byteSize,
  };
}

function safeWorkflowError(error: BoundaryError): string {
  return error instanceof Error ? error.message : "Managed publication failed";
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/renders") {
      return createRender(request, env);
    }

    const jobId = /^\/api\/renders\/([^/]+)$/.exec(url.pathname)?.[1];
    if (request.method === "GET" && jobId) {
      return getRender(decodeURIComponent(jobId), env, (status) =>
        mapWorkflowStatus(status),
      );
    }

    const internalMediaRoute = /^\/api\/internal\/project-media\/([^/]+)$/.exec(
      url.pathname,
    );
    if (request.method === "GET" && internalMediaRoute) {
      const authorization = request.headers.get("authorization");
      const token = authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : null;
      if (!token) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return getProjectMediaByCapability(
        decodeURIComponent(internalMediaRoute[1]!),
        token,
        env,
      );
    }

    const internalReferenceRoute =
      /^\/api\/internal\/project-references\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && internalReferenceRoute) {
      const authorization = request.headers.get("authorization");
      const token = authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : null;
      if (!token) return Response.json({ error: "Not found" }, { status: 404 });
      return getReferenceByCapability(internalReferenceRoute[1]!, token, env);
    }

    if (url.pathname === "/api/projects" && request.method === "GET") {
      const ownerEmail = await accessEmail(request, env, ctx);
      return ownerEmail
        ? listProjects(ownerEmail, env)
        : Response.json({ error: "Authentication required" }, { status: 401 });
    }
    if (url.pathname === "/api/projects" && request.method === "POST") {
      const ownerEmail = await accessEmail(request, env, ctx);
      return ownerEmail
        ? createProject(request, ownerEmail, env)
        : Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const referenceContentRoute =
      /^\/api\/projects\/([^/]+)\/references\/([^/]+)\/content$/.exec(
        url.pathname,
      );
    if (request.method === "GET" && referenceContentRoute) {
      const ownerEmail = await accessEmail(request, env, ctx);
      if (!ownerEmail) {
        return Response.json(
          { error: "Authentication required" },
          { status: 401 },
        );
      }
      return getReferenceContent(
        decodeURIComponent(referenceContentRoute[1]!),
        decodeURIComponent(referenceContentRoute[2]!),
        ownerEmail,
        env,
      );
    }

    const projectRoute =
      /^\/api\/projects\/([^/]+)(?:\/(references|handoffs|revisions|brief|feedback))?$/.exec(
        url.pathname,
      );
    if (projectRoute) {
      const ownerEmail = await accessEmail(request, env, ctx);
      if (!ownerEmail) {
        return Response.json(
          { error: "Authentication required" },
          { status: 401 },
        );
      }
      const projectId = decodeURIComponent(projectRoute[1]!);
      if (request.method === "GET" && !projectRoute[2]) {
        return getProject(projectId, ownerEmail, env);
      }
      if (request.method === "POST" && projectRoute[2] === "references") {
        return createReferenceUpload(request, projectId, ownerEmail, env);
      }
      if (request.method === "POST" && projectRoute[2] === "handoffs") {
        return createHandoff(projectId, ownerEmail, env, url.origin);
      }
      if (request.method === "PUT" && projectRoute[2] === "brief") {
        return saveProjectBrief(request, projectId, ownerEmail, env);
      }
      if (request.method === "POST" && projectRoute[2] === "feedback") {
        return createProjectFeedback(request, projectId, ownerEmail, env);
      }
      if (request.method === "GET" && projectRoute[2] === "revisions") {
        return listProjectRevisions(projectId, ownerEmail, env.PROJECTS_DB);
      }
      if (request.method === "POST" && projectRoute[2] === "revisions") {
        return submitRevisionBundle(request, projectId, ownerEmail, env);
      }
    }

    const publicationCreateRoute =
      /^\/api\/projects\/([^/]+)\/revisions\/([^/]+)\/publications$/.exec(
        url.pathname,
      );
    if (request.method === "POST" && publicationCreateRoute) {
      const ownerEmail = await accessEmail(request, env, ctx);
      if (!ownerEmail)
        return Response.json(
          { error: "Authentication required" },
          { status: 401 },
        );
      const projectId = decodeURIComponent(publicationCreateRoute[1]!);
      const revisionId = decodeURIComponent(publicationCreateRoute[2]!);
      return createManagedPublication(
        request,
        projectId,
        revisionId,
        ownerEmail,
        env,
        () =>
          getRevisionSourceProvenance(projectId, revisionId, ownerEmail, env),
      );
    }

    const publicationRoute =
      /^\/api\/projects\/([^/]+)\/publications(?:\/([^/]+)(?:\/(retry))?)?$/.exec(
        url.pathname,
      );
    if (publicationRoute) {
      const ownerEmail = await accessEmail(request, env, ctx);
      if (!ownerEmail)
        return Response.json(
          { error: "Authentication required" },
          { status: 401 },
        );
      const projectId = decodeURIComponent(publicationRoute[1]!);
      const publicationId = publicationRoute[2]
        ? decodeURIComponent(publicationRoute[2])
        : undefined;
      if (request.method === "GET" && !publicationId)
        return listManagedPublications(projectId, ownerEmail, env.PROJECTS_DB);
      if (request.method === "GET" && publicationId && !publicationRoute[3])
        return getManagedPublication(
          projectId,
          publicationId,
          ownerEmail,
          env.PROJECTS_DB,
        );
      if (
        request.method === "POST" &&
        publicationId &&
        publicationRoute[3] === "retry"
      )
        return retryManagedPublication(
          projectId,
          publicationId,
          ownerEmail,
          env,
        );
    }

    const mediaRoute =
      /^\/api\/projects\/([^/]+)\/media(?:\/(audio|captions|[^/]+)(?:\/(content|validate-audio))?)?$/.exec(
        url.pathname,
      );
    if (mediaRoute) {
      const ownerEmail = await accessEmail(request, env, ctx);
      if (!ownerEmail)
        return Response.json(
          { error: "Authentication required" },
          { status: 401 },
        );
      const projectId = decodeURIComponent(mediaRoute[1]!);
      const segment = mediaRoute[2]
        ? decodeURIComponent(mediaRoute[2])
        : undefined;
      const action = mediaRoute[3];
      if (request.method === "GET" && !segment) {
        const kind = url.searchParams.get("kind");
        if (kind !== null && kind !== "audio" && kind !== "captions")
          return Response.json(
            { error: "Invalid media kind" },
            { status: 400 },
          );
        return listProjectMedia(projectId, ownerEmail, kind ?? undefined, env);
      }
      if (
        request.method === "POST" &&
        (segment === "audio" || segment === "captions") &&
        !action
      ) {
        return createProjectMediaUpload(
          request,
          projectId,
          ownerEmail,
          segment,
          env,
        );
      }
      if (request.method === "GET" && segment && !action)
        return getProjectMediaMetadata(projectId, segment, ownerEmail, env);
      if (request.method === "GET" && segment && action === "content")
        return getProjectMediaContent(projectId, segment, ownerEmail, env);
      if (request.method === "POST" && segment && action === "validate-audio") {
        return validateProjectAudioWithRenderer(
          projectId,
          segment,
          ownerEmail,
          env.STUDIO_ORIGIN,
          getContainer(env.RENDERER, `audio-${segment}`),
          env,
        );
      }
    }

    const revisionActionRoute =
      /^\/api\/projects\/([^/]+)\/revisions\/([^/]+)\/(preview-session|approval|build-retry)$/.exec(
        url.pathname,
      );
    if (request.method === "POST" && revisionActionRoute) {
      const ownerEmail = await accessEmail(request, env, ctx);
      if (!ownerEmail) {
        return Response.json(
          { error: "Authentication required" },
          { status: 401 },
        );
      }
      const projectId = decodeURIComponent(revisionActionRoute[1]!);
      const revisionId = decodeURIComponent(revisionActionRoute[2]!);
      if (revisionActionRoute[3] === "build-retry") {
        return requestRevisionBuildRetry(
          request,
          projectId,
          revisionId,
          ownerEmail,
          env,
        );
      }
      if (revisionActionRoute[3] === "preview-session") {
        return createPreviewSession(
          projectId,
          revisionId,
          ownerEmail,
          env,
          url.origin,
        );
      }
      const provenance = await getRevisionSourceProvenance(
        projectId,
        revisionId,
        ownerEmail,
        env,
      );
      if (!provenance.ok) return provenance;
      await provenance.body?.cancel();
      if (revisionActionRoute[3] === "approval") {
        return approveRevision(
          projectId,
          revisionId,
          ownerEmail,
          env.PROJECTS_DB,
        );
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const revisionProvenanceRoute =
      /^\/api\/projects\/([^/]+)\/revisions\/([^/]+)\/provenance$/.exec(
        url.pathname,
      );
    if (request.method === "GET" && revisionProvenanceRoute) {
      const ownerEmail = await accessEmail(request, env, ctx);
      if (!ownerEmail) {
        return Response.json(
          { error: "Authentication required" },
          { status: 401 },
        );
      }
      return getRevisionSourceProvenance(
        decodeURIComponent(revisionProvenanceRoute[1]!),
        decodeURIComponent(revisionProvenanceRoute[2]!),
        ownerEmail,
        env,
      );
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
