import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { fileURLToPath, URL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

function rendererGraphArtifact(): Plugin {
  return {
    name: "patchdesk-renderer-graph-artifact",
    async generateBundle(options, bundle) {
      const chunks: Array<{
        readonly fileName: string;
        readonly imports: ReadonlyArray<string>;
        readonly dynamicImports: ReadonlyArray<string>;
        readonly isEntry: boolean;
        readonly isDynamicEntry: boolean;
        readonly modules: ReadonlyArray<string>;
      }> = [];
      // `bundle`'s contextual type already comes from Rollup's own
      // `OutputBundle` (Record<string, OutputChunk | OutputAsset>) via the
      // `Plugin["generateBundle"]` hook signature -- no cast needed.
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        chunks.push({
          fileName: output.fileName,
          imports: output.imports,
          dynamicImports: output.dynamicImports,
          isEntry: output.isEntry,
          isDynamicEntry: output.isDynamicEntry,
          modules: Object.keys(output.modules).sort(),
        });
      }
      chunks.sort((left, right) => left.fileName.localeCompare(right.fileName));
      const outputDirectory = options.dir ?? "out/renderer";
      // `generateBundle` runs before Rollup writes the bundle, so on a clean
      // tree (fresh clone or worktree) `outputDirectory` doesn't exist yet.
      // Without this, the first build always fails with ENOENT.
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(
        join(outputDirectory, "renderer-graph.json"),
        `${JSON.stringify({ chunks }, null, 2)}\n`,
      );
    },
  };
}

/** Builds Electron's privileged processes separately from the isolated React renderer. */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          "electron-main": "src/main/electron-main.ts",
        },
      },
    },
  },
  preload: {
    build: {
      // The sandbox cannot resolve external Node packages from a preload script.
      externalizeDeps: false,
      rollupOptions: {
        input: "src/main/preload.ts",
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss(), rendererGraphArtifact()],
    build: {
      manifest: true,
    },
    // @pierre/diffs' syntax-highlighting worker (mounted in
    // diff-worker-pool.tsx) code-splits internally for a conditional
    // `import("shiki/wasm")`. Vite's default worker.format is "iife", which
    // Rollup rejects for code-splitting builds; "es" is required.
    worker: {
      format: "es",
    },
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src/renderer/src", import.meta.url)),
      },
    },
  },
});
