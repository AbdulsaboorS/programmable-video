import {
  renderStatusSchema,
  type RenderStatus,
} from "@programmable-video/contracts";
import { z } from "zod";

type FailureStage = "validation" | "render" | "upload" | "processing";

const failureStageSchema = z.enum([
  "validation",
  "render",
  "upload",
  "processing",
]);
const workflowStatusSchema = z.object({
  status: z.enum([
    "queued",
    "running",
    "paused",
    "errored",
    "terminated",
    "complete",
    "waiting",
    "waitingForPause",
    "unknown",
  ]),
  error: z.object({ name: z.string(), message: z.string() }).optional(),
  output: z.unknown().optional(),
});
const workflowStatusInputSchema = z.unknown();

export type WorkflowStatusView = z.output<typeof workflowStatusSchema>;
export type WorkflowStatusInput = z.input<typeof workflowStatusInputSchema>;

export function parseWorkflowStatus(
  input: WorkflowStatusInput,
): WorkflowStatusView {
  const parsed = workflowStatusSchema.safeParse(input);
  return parsed.success ? parsed.data : { status: "unknown" };
}

const workflowErrorPattern =
  /^\[(validation|render|upload|processing)\] (.+)$/s;

const failedStatus: RenderStatus = {
  status: "failed",
  error: { stage: "render", message: "Render failed" },
};

export function mapWorkflowStatus(status: WorkflowStatusView): RenderStatus {
  if (status.status === "queued") return { status: "queued" };
  if (status.status === "running" || status.status === "waiting") {
    return { status: "rendering" };
  }
  if (status.status === "complete") {
    const output = renderStatusSchema.safeParse(status.output);
    return output.success && output.data.status === "ready"
      ? output.data
      : failedStatus;
  }
  if (status.status === "errored") {
    const match = status.error?.message.match(workflowErrorPattern);
    const stage = failureStageSchema.safeParse(match?.[1]);
    if (stage.success && match?.[2] !== undefined) {
      return {
        status: "failed",
        error: {
          stage: stage.data,
          message: match[2],
        },
      };
    }
  }
  return failedStatus;
}

export async function withWorkflowFailure<T>(
  stage: FailureStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure";
    if (workflowErrorPattern.test(message)) throw error;
    throw new Error(`[${stage}] ${message}`);
  }
}
