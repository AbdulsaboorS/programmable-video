import { fileURLToPath, URL } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), ...(process.env.VITEST ? [] : [cloudflare()])],
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
});
