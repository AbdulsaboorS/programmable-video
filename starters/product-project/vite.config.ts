import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

import { videoSpec } from "./src/story.ts";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");

  return {
    base: "./",
    define: {
      __VIDEO_BUILD_ATTEMPT__: JSON.stringify(
        env.VIDEO_BUILD_ATTEMPT ?? "placeholder-build-attempt",
      ),
      __VIDEO_COMMIT_SHA__: JSON.stringify(
        env.VIDEO_COMMIT_SHA ?? "placeholder-commit-sha",
      ),
      __VIDEO_INPUT_DIGEST__: JSON.stringify(
        env.VIDEO_INPUT_DIGEST ?? "placeholder-input-digest",
      ),
    },
    plugins: [
      react(),
      {
        name: "video-spec",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "video-spec.json",
            source: JSON.stringify(videoSpec),
          });
        },
      },
    ],
    build: {
      rollupOptions: {
        input: {
          index: new URL("./index.html", import.meta.url).pathname,
          render: new URL("./render.html", import.meta.url).pathname,
        },
      },
    },
  };
});
