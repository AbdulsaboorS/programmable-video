import { fileURLToPath, URL } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => {
  const persistState = {
    path: process.env.PV_PERSIST_PATH ?? "../../.wrangler/state",
  };
  const cloudflarePlugin =
    command === "serve"
      ? cloudflare({
          persistState,
          config(workerConfig) {
            workerConfig.compatibility_date = "2026-08-27";
            workerConfig.vars = {
              ...workerConfig.vars,
              PREVIEW_ORIGIN:
                process.env.PV_PREVIEW_ORIGIN ??
                `http://localhost:${process.env.PV_PREVIEW_PORT ?? "5174"}`,
              STUDIO_ORIGIN:
                process.env.PV_STUDIO_ORIGIN ??
                `http://localhost:${process.env.PV_STUDIO_PORT ?? "5173"}`,
            };
            if (process.env.CONTAINER_EXTRA_CA_CERT) {
              workerConfig.vars.CONTAINER_EXTRA_CA_CERT =
                process.env.CONTAINER_EXTRA_CA_CERT;
            }
            Reflect.deleteProperty(workerConfig, "artifacts");
            if (workerConfig.triggers) {
              Reflect.deleteProperty(workerConfig.triggers, "events");
            }
          },
        })
      : cloudflare({ persistState });

  return {
    plugins: [react(), ...(process.env.VITEST ? [] : [cloudflarePlugin])],
    environments: {
      client: {
        build: {
          emptyOutDir: false,
          outDir: "dist",
          rollupOptions: {
            input: {
              studio: fileURLToPath(new URL("./index.html", import.meta.url)),
              render: fileURLToPath(new URL("./render.html", import.meta.url)),
            },
          },
        },
      },
    },
  };
});
