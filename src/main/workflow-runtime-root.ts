import { existsSync } from "node:fs";
import { join } from "node:path";

/** Resolves a runnable Flue project, preferring the checkout that owns packaged internal builds. */
export function resolveWorkflowRuntimeRoot(
  appPath: string,
  cwd: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const hasConfig = exists(join(cwd, "flue.config.ts"));
  const hasCli = exists(join(cwd, "node_modules/@flue/cli/bin/flue.mjs"));
  return hasConfig && hasCli ? cwd : appPath;
}
