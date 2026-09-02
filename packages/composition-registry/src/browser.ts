import type { InferCompositionProps } from "@programmable-video/contracts";
import { ProductLaunchComposition } from "@programmable-video/product-launch/browser";
import { productLaunchManifest } from "@programmable-video/product-launch/manifest";
import { SupportAgentComposition } from "@programmable-video/support-agent/browser";
import { supportAgentManifest } from "@programmable-video/support-agent/manifest";
import type { ComponentType } from "react";

import {
  compositionManifests,
  type CompositionId,
  type RegisteredCompositionManifest,
} from "./index";

export type CompositionRenderer<Props> = ComponentType<{
  frame: number;
  props: Props;
}>;

type ManifestFor<Id extends CompositionId> = Extract<
  RegisteredCompositionManifest,
  { id: Id }
>;

type BrowserCompositionRegistry = {
  [Id in CompositionId]: {
    manifest: ManifestFor<Id>;
    Renderer: CompositionRenderer<InferCompositionProps<ManifestFor<Id>>>;
    requiredFonts: readonly string[];
  };
};

export const browserCompositionRegistry = {
  "support-agent": {
    manifest: supportAgentManifest,
    Renderer: SupportAgentComposition,
    requiredFonts: ['16px "Manrope Variable"', '16px "IBM Plex Mono"'],
  },
  "product-launch": {
    manifest: productLaunchManifest,
    Renderer: ProductLaunchComposition,
    requiredFonts: ['16px "Manrope Variable"', '16px "IBM Plex Mono"'],
  },
} satisfies BrowserCompositionRegistry;

const manifestIds = compositionManifests.map((manifest) => manifest.id);
const rendererIds = Object.keys(browserCompositionRegistry);
if (
  manifestIds.length !== rendererIds.length ||
  manifestIds.some((id) => !rendererIds.includes(id))
) {
  throw new Error("Browser renderers must exactly cover composition manifests");
}

export function getBrowserComposition<Id extends CompositionId>(
  id: Id,
): BrowserCompositionRegistry[Id] {
  return browserCompositionRegistry[id];
}
