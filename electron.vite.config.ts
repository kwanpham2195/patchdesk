import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { fileURLToPath, URL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, type Plugin } from "vite";
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

/**
 * Builds the MCP shim (ADR 0052) as `out/main/mcp-shim.js`, one file with the
 * MCP SDK and every other import inlined, because packaging stages it alone
 * outside the asar. A second input to the main build would share chunks with
 * `electron-main.js` and externalize `dependencies`, so it is a nested build
 * whose output the main build emits.
 */
function mcpShimBundle(): Plugin {
  return {
    name: "patchdesk-mcp-shim-bundle",
    apply: "build",
    async buildStart() {
      const output = await build({
        configFile: false,
        resolve: {
          alias: {
            "#src": fileURLToPath(new URL("./src", import.meta.url)),
            "#package": fileURLToPath(
              new URL("./package.json", import.meta.url),
            ),
          },
        },
        logLevel: "warn",
        build: {
          ssr: "src/mcp/main.ts",
          target: "node22",
          write: false,
          minify: false,
          rollupOptions: {
            output: { format: "es", inlineDynamicImports: true },
          },
        },
        ssr: { noExternal: true, target: "node" },
      });
      const outputs = Array.isArray(output) ? output : [output];
      for (const { output: chunks } of outputs.flatMap((entry) =>
        "output" in entry ? [entry] : [],
      )) {
        for (const chunk of chunks) {
          if (chunk.type !== "chunk") continue;
          for (const id of chunk.moduleIds) this.addWatchFile(id);
          this.emitFile({
            type: "asset",
            fileName: "mcp-shim.js",
            source: chunk.code,
          });
        }
      }
    },
  };
}

/** The Bash helper is staged alone, so its bundle must contain every non-builtin import. */
function piExplanationHelperBundle(): Plugin {
  return {
    name: "patchdesk-pi-explanation-helper-bundle",
    apply: "build",
    async buildStart() {
      const output = await build({
        configFile: false,
        logLevel: "warn",
        build: {
          ssr: "src/adapters/pi-cli/pi-explanation-helper.ts",
          target: "node22",
          write: false,
          minify: false,
          rollupOptions: {
            output: { format: "es", inlineDynamicImports: true },
          },
        },
        ssr: { noExternal: true, target: "node" },
      });
      for (const entry of Array.isArray(output) ? output : [output]) {
        if (!("output" in entry)) continue;
        for (const chunk of entry.output) {
          if (chunk.type !== "chunk") continue;
          for (const id of chunk.moduleIds) this.addWatchFile(id);
          this.emitFile({
            type: "asset",
            fileName: "pi-explanation-helper.mjs",
            source: chunk.code,
          });
        }
      }
    },
  };
}

/** Builds Electron's privileged processes separately from the isolated React renderer. */
export default defineConfig(({ command }) => ({
  main: {
    define: {
      __PATCHDESK_CAPTURE_DIAGNOSTICS__: JSON.stringify(command === "serve"),
    },
    plugins: [
      externalizeDepsPlugin(),
      mcpShimBundle(),
      piExplanationHelperBundle(),
    ],
    resolve: {
      alias: {
        "#src": fileURLToPath(new URL("./src", import.meta.url)),
        "#package": fileURLToPath(new URL("./package.json", import.meta.url)),
      },
    },
    build: {
      rollupOptions: {
        input: {
          "electron-main": "src/main/electron-main.ts",
          "insight-artifact-worker":
            "src/adapters/storage/insight-artifact-worker-entry.ts",
          "insight-artifact-job":
            "src/adapters/storage/insight-artifact-job-entry.ts",
        },
        output: { entryFileNames: "[name].js" },
      },
    },
  },
  preload: {
    define: {
      __PATCHDESK_CAPTURE_DIAGNOSTICS__: JSON.stringify(command === "serve"),
    },
    resolve: {
      alias: { "#src": fileURLToPath(new URL("./src", import.meta.url)) },
    },
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
    // A worktree's `pnpm dev` hands its own port; strict so a clash fails instead of moving the origin.
    server:
      process.env.PATCHDESK_VITE_PORT === undefined
        ? {}
        : { port: Number(process.env.PATCHDESK_VITE_PORT), strictPort: true },
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
        "#src": fileURLToPath(new URL("./src", import.meta.url)),
        "#resources": fileURLToPath(new URL("./resources", import.meta.url)),
      },
    },
  },
}));
