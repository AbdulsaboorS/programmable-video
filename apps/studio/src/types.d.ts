import type { VideoSpec } from "@programmable-video/contracts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface FrameAcknowledgement {
  buildId: string;
  frame: number;
  height: number;
  width: number;
}

export interface VideoRendererBridge {
  buildId: string;
  initialize(
    compositionId: string,
    props: JsonValue,
  ): Promise<FrameAcknowledgement>;
  renderFrame(frame: number, props?: JsonValue): Promise<FrameAcknowledgement>;
  spec: VideoSpec;
  version: "1";
}

declare global {
  interface Window {
    __VIDEO_RENDERER__?: VideoRendererBridge;
  }
}
