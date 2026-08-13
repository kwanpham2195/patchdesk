import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { generatedPiAiCatalog } from "../adapters/pi/pi-ai-catalog.generated";

const FLUE_VERSION = "2.0.3";
const PI_VERSION = "0.84.1";
const NODE_FLOOR = ">=22.19.0";

type RuntimeManifest = {
  readonly flueVersion: string;
  readonly piVersion: string;
  readonly catalogDigest: string;
  readonly nodeFloor: string;
  readonly lockDigest: string;
};

export type InsightRuntime = {
  readonly root: string;
  readonly runnerPath: string;
  readonly manifestPath: string;
};

/** Resolves only a verified one-shot Insight runtime; old CLI/workflow trees never qualify. */
export function resolveInsightRuntime(
  appPath: string,
  cwd: string,
  exists: (path: string) => boolean = existsSync,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): InsightRuntime | undefined {
  const packaged = join(dirname(appPath), "flue-runtime");
  const staged = join(cwd, "out", "workflow-runtime");
  const development = join(cwd, "runtime", "flue");
  for (const candidate of [
    { root: packaged, runnerPath: join(packaged, "patchdesk-insight-runner.js") },
    { root: staged, runnerPath: join(staged, "patchdesk-insight-runner.js") },
    { root: development, runnerPath: join(development, "dist", "patchdesk-insight-runner.js") },
  ]) {
    const manifestPath = join(candidate.root, "runtime-manifest.json");
    if (!exists(candidate.runnerPath) || !exists(manifestPath)) continue;
    if (validManifest(candidate.root, manifestPath, readFile)) {
      return { ...candidate, manifestPath };
    }
  }
  return undefined;
}

function validManifest(
  root: string,
  manifestPath: string,
  readFile: (path: string) => string,
): boolean {
  try {
    const manifest = JSON.parse(readFile(manifestPath)) as RuntimeManifest;
    if (
      manifest.flueVersion !== FLUE_VERSION ||
      manifest.piVersion !== PI_VERSION ||
      manifest.catalogDigest !== catalogDigest() ||
      manifest.nodeFloor !== NODE_FLOOR ||
      !/^[a-f0-9]{64}$/.test(manifest.lockDigest)
    ) return false;
    const lock = readFile(join(root, "pnpm-lock.yaml"));
    return createHash("sha256").update(lock).digest("hex") === manifest.lockDigest;
  } catch {
    return false;
  }
}

function catalogDigest(): string | undefined {
  if (typeof generatedPiAiCatalog !== "object" || generatedPiAiCatalog === null) return undefined;
  const digest = (generatedPiAiCatalog as { readonly digest?: unknown }).digest;
  return typeof digest === "string" ? digest : undefined;
}
