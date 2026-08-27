import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import * as v from "valibot";

import { generatedPiAiCatalog } from "../adapters/pi/pi-ai-catalog.generated";

const FLUE_VERSION = "2.0.3";
const PI_VERSION = "0.84.1";
const NODE_FLOOR = ">=22.19.0";

/** The staged runtime's own manifest, as it is read back off disk. */
const runtimeManifestSchema = v.object({
  flueVersion: v.string(),
  piVersion: v.string(),
  catalogDigest: v.string(),
  nodeFloor: v.string(),
  lockDigest: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});

/** Only the one field this module reads out of the generated Pi catalog. */
const catalogDigestSchema = v.object({ digest: v.string() });

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
    {
      root: packaged,
      runnerPath: join(packaged, "patchdesk-insight-runner.js"),
    },
    { root: staged, runnerPath: join(staged, "patchdesk-insight-runner.js") },
    {
      root: development,
      runnerPath: join(development, "dist", "patchdesk-insight-runner.js"),
    },
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
    const manifest = v.safeParse(
      runtimeManifestSchema,
      JSON.parse(readFile(manifestPath)),
    );
    if (
      !manifest.success ||
      manifest.output.flueVersion !== FLUE_VERSION ||
      manifest.output.piVersion !== PI_VERSION ||
      manifest.output.catalogDigest !== catalogDigest() ||
      manifest.output.nodeFloor !== NODE_FLOOR
    )
      return false;
    const lock = readFile(join(root, "pnpm-lock.yaml"));
    return (
      createHash("sha256").update(lock).digest("hex") ===
      manifest.output.lockDigest
    );
  } catch {
    return false;
  }
}

function catalogDigest(): string | undefined {
  const parsed = v.safeParse(catalogDigestSchema, generatedPiAiCatalog);
  return parsed.success ? parsed.output.digest : undefined;
}
