import { productLaunchManifest } from "@programmable-video/product-launch/manifest";
import { supportAgentManifest } from "@programmable-video/support-agent/manifest";
import { z } from "zod";

export const compositionManifests = [
  supportAgentManifest,
  productLaunchManifest,
] as const;

export type RegisteredCompositionManifest =
  (typeof compositionManifests)[number];
export type CompositionId = RegisteredCompositionManifest["id"];
export type CompositionProps = Record<string, string>;

interface ParsedCompositionProps {
  compositionId: CompositionId;
  props: CompositionProps;
}

const renderRequestTransportSchema = z
  .object({
    compositionId: z.string().trim().min(1),
    props: z.record(z.string(), z.string()),
    buildId: z.string().trim().min(1).max(120),
  })
  .strict();

const streamUploadSchema = z
  .object({
    videoId: z.string().trim().min(1),
    uploadUrl: z.url(),
  })
  .strict();

const containerRenderRequestTransportSchema = renderRequestTransportSchema
  .extend({
    jobId: z.string().uuid(),
    streamUpload: streamUploadSchema,
  })
  .strict();

export type RenderRequest = {
  compositionId: CompositionId;
  props: CompositionProps;
  buildId: string;
};

export type ContainerRenderRequest = RenderRequest & {
  jobId: string;
  streamUpload: z.output<typeof streamUploadSchema>;
};

export function getCompositionManifest(
  id: string,
): RegisteredCompositionManifest | undefined {
  return compositionManifests.find((manifest) => manifest.id === id);
}

export function parseCompositionProps<Input>(
  compositionId: string,
  props: Input,
): ParsedCompositionProps {
  const manifest = getCompositionManifest(compositionId);
  if (manifest === undefined) {
    throw new Error(`Unknown composition: ${compositionId}`);
  }
  return {
    compositionId: manifest.id,
    props: manifest.propsSchema.parse(props),
  };
}

export function parseRenderRequest<Input>(value: Input): RenderRequest {
  const transport = renderRequestTransportSchema.parse(value);
  return {
    ...transport,
    ...parseCompositionProps(transport.compositionId, transport.props),
  };
}

export function parseContainerRenderRequest<Input>(
  value: Input,
): ContainerRenderRequest {
  const transport = containerRenderRequestTransportSchema.parse(value);
  return {
    ...transport,
    ...parseCompositionProps(transport.compositionId, transport.props),
  };
}
