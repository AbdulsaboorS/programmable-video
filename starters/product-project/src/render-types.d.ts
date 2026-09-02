declare const __VIDEO_BUILD_ATTEMPT__: string;
declare const __VIDEO_COMMIT_SHA__: string;
declare const __VIDEO_INPUT_DIGEST__: string;

interface Window {
  __VIDEO_RENDERER__?: import("./render-bridge").VideoRendererBridge;
}
