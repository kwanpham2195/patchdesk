import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "#app": fileURLToPath(new URL("../../src", import.meta.url)) },
  },
  build: {
    ssr: true,
    target: "node22",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: {
        "patchdesk-insight-runner": "src/patchdesk-insight-runner.ts",
        "package-smoke-runner": "src/package-smoke-runner.ts",
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: [
        "@earendil-works/pi-agent-core",
        "@earendil-works/pi-ai",
        "@earendil-works/pi-ai/providers/all",
        "@valibot/to-json-schema",
        "valibot",
      ],
    },
  },
});
