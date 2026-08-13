import { defineConfig } from "vite";

export default defineConfig({
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
      external: ["@flue/runtime", "@flue/runtime/node", "@earendil-works/pi-ai", "valibot"],
    },
  },
});
