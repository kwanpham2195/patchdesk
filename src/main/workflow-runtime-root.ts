import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Resolves a runnable Flue project, preferring the checkout that owns packaged internal builds. */
export function resolveWorkflowRuntimeRoot(
  appPath: string,
  cwd: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const packagedRuntime = join(dirname(appPath), "flue-runtime");
  if (exists(join(packagedRuntime, "flue.config.ts")) && exists(join(packagedRuntime, "node_modules", ".pnpm"))) {
    return packagedRuntime;
  }
  const hasConfig = exists(join(cwd, "flue.config.ts"));
  const hasCli = exists(join(cwd, "node_modules/@flue/cli/bin/flue.mjs"));
  return hasConfig && hasCli ? cwd : appPath;
}

/** Resolves the isolated packaged project that discovers only the walkthrough workflow. */
export function resolveWalkthroughRuntimeRoot(
  appPath: string,
  cwd: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const packagedRuntime = join(dirname(appPath), "flue-runtime", "walkthrough");
  if (exists(join(packagedRuntime, "flue.config.ts"))) return packagedRuntime;

  const stagedRuntime = join(cwd, "out", "workflow-runtime", "walkthrough");
  if (exists(join(stagedRuntime, "flue.config.ts"))) return stagedRuntime;

  return resolveWorkflowRuntimeRoot(appPath, cwd, exists);
}

/** Resolves the staged CLI through pnpm's virtual store after Electron copies its runtime assets. */
export function resolveWorkflowCliPath(
  runtimeRoot: string,
  exists: (path: string) => boolean = existsSync,
  readDirectory: (path: string) => ReadonlyArray<string> = readdirSync,
): string {
  for (const root of [runtimeRoot, dirname(runtimeRoot)]) {
    const direct = join(root, "node_modules", "@flue", "cli", "bin", "flue.mjs");
    if (exists(direct)) return direct;
    const store = join(root, "node_modules", ".pnpm");
    try {
      const entry = readDirectory(store).find((name) => name.startsWith("@flue+cli@"));
      if (entry !== undefined) {
        const staged = join(store, entry, "node_modules", "@flue", "cli", "bin", "flue.mjs");
        if (exists(staged)) return staged;
      }
    } catch {
      // Try the parent runtime when the isolated project has no node_modules directory.
    }
  }
  return join(runtimeRoot, "node_modules", "@flue", "cli", "bin", "flue.mjs");
}
