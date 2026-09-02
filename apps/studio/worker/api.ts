import { parseRenderRequest } from "@programmable-video/composition-registry";
import { z } from "zod";

import { isUuid } from "./worker-utils";
import {
  parseWorkflowStatus,
  type WorkflowStatusInput,
  type WorkflowStatusView,
} from "./status";

const maxRequestBytes = 1024 * 1024;
const jsonValueSchema = z.json();

export interface RenderApiEnv {
  BUILD_ID: string;
  RENDER_WORKFLOW: {
    create(options: {
      id: string;
      params: ReturnType<typeof parseRenderRequest>;
    }): Promise<WorkflowInstance | void>;
    get(id: string): Promise<{
      status(): Promise<WorkflowStatusInput>;
    }>;
  };
}

export async function createRender(
  request: Request,
  env: RenderApiEnv,
): Promise<Response> {
  let body: unknown;
  try {
    body = JSON.parse(await readLimitedBody(request));
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof RequestTooLargeError
            ? "Render request exceeds 1 MB"
            : "Invalid render request",
      },
      { status: error instanceof RequestTooLargeError ? 413 : 400 },
    );
  }

  let parsed: ReturnType<typeof parseRenderRequest>;
  try {
    parsed = parseRenderRequest(jsonValueSchema.parse(body));
  } catch {
    return Response.json({ error: "Invalid render request" }, { status: 400 });
  }
  if (parsed.buildId !== env.BUILD_ID) {
    return Response.json({ error: "Studio build mismatch" }, { status: 409 });
  }

  const jobId = crypto.randomUUID();
  await env.RENDER_WORKFLOW.create({ id: jobId, params: parsed });
  return Response.json(
    { jobId, statusUrl: `/api/renders/${jobId}` },
    { status: 202 },
  );
}

export async function getRender<MappedStatus>(
  jobId: string,
  env: RenderApiEnv,
  mapStatus: (status: WorkflowStatusView) => MappedStatus,
): Promise<Response> {
  if (!isUuid(jobId)) {
    return Response.json({ error: "Render not found" }, { status: 404 });
  }
  try {
    const instance = await env.RENDER_WORKFLOW.get(jobId);
    const status = parseWorkflowStatus(await instance.status());
    return Response.json(jsonValueSchema.parse(mapStatus(status)));
  } catch {
    return Response.json({ error: "Render not found" }, { status: 404 });
  }
}

export async function readLimitedBody(request: Request): Promise<string> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
    throw new RequestTooLargeError();
  }

  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxRequestBytes) {
      await reader.cancel();
      throw new RequestTooLargeError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export class RequestTooLargeError extends Error {}
