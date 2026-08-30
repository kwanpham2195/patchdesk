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
  /**
   * Which tree this runtime was resolved from, so the main process can name it
   * in one startup log line: the three roots hold different builds of the same
   * runner, and reading a stale one is silent otherwise.
   */
  readonly kind: "packaged" | "staged" | "development";
  readonly root: string;
  readonly runnerPath: string;
  readonly manifestPath: string;
};

/**
 * Resolves only a verified one-shot Insight runtime; old CLI/workflow trees
 * never qualify.
 *
 * An unpackaged run prefers the development build over the staged one.
 * `pnpm dev` rebuilds `runtime/flue/dist` on every start, while
 * `out/workflow-runtime` is written only by `pnpm stage:flue-runtime` during
 * packaging, and `runtime-manifest.json` pins the Flue and Pi versions, the
 * catalog digest, the node floor and the lock digest -- nothing that changes
 * when the runner itself gains a request type. A staging left over from an
 * earlier packaging therefore passes every manifest check and still answers
 * `invalid_input` to a request type it predates. Packaged resolution is
 * unchanged: only the packaged root ships beside a packaged app, and ADR 0018
 * keeps that a separate exact package with a committed lock.
 */
export function resolveInsightRuntime(
  appPath: string,
  cwd: string,
  isPackaged: boolean,
  exists: (path: string) => boolean = existsSync,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): InsightRuntime | undefined {
  const packagedRoot = join(dirname(appPath), "flue-runtime");
  const stagedRoot = join(cwd, "out", "workflow-runtime");
  const developmentRoot = join(cwd, "runtime", "flue");
  const packaged = {
    kind: "packaged",
    root: packagedRoot,
    runnerPath: join(packagedRoot, "patchdesk-insight-runner.js"),
  } as const;
  const staged = {
    kind: "staged",
    root: stagedRoot,
    runnerPath: join(stagedRoot, "patchdesk-insight-runner.js"),
  } as const;
  const development = {
    kind: "development",
    root: developmentRoot,
    runnerPath: join(developmentRoot, "dist", "patchdesk-insight-runner.js"),
  } as const;
  for (const candidate of isPackaged
    ? [packaged, staged, development]
    : [packaged, development, staged]) {
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
