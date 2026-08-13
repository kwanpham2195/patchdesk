import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { fileURLToPath, URL } from "node:url";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

type RendererChunk = {
  readonly type: "chunk";
  readonly fileName: string;
  readonly imports: ReadonlyArray<string>;
  readonly dynamicImports: ReadonlyArray<string>;
  readonly isEntry: boolean;
  readonly isDynamicEntry: boolean;
  readonly modules: Record<string, unknown>;
};

type RendererBundle = Record<string, RendererChunk | { readonly type: "asset" }>;

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
      for (const output of Object.values(bundle as unknown as RendererBundle)) {
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
      const outputDirectory = typeof options.dir === "string" ? options.dir : "out/renderer";
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
        input: "src/main/electron-main.ts",
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
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src/renderer/src", import.meta.url)),
      },
    },
  },
});
