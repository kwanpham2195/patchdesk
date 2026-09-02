import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const PI_VERSION = "0.84.4";
const NODE_FLOOR = ">=22.19.0";

/** Stages the exact self-contained Flue 2 one-shot runtime for Electron resources. */
export async function stageFlueRuntime({ projectRoot, runtimeRoot, run }) {
  const source = join(projectRoot, "runtime", "flue");
  const manifest = join(source, "package.json");
  const lockfile = join(source, "pnpm-lock.yaml");
  const dist = join(source, "dist");

  await rm(runtimeRoot, { recursive: true, force: true });
  await mkdir(runtimeRoot, { recursive: true });
  await Promise.all([access(manifest), access(lockfile)]);
  const sourceManifest = JSON.parse(await readFile(manifest, "utf8"));
  if (
    sourceManifest.dependencies?.["@earendil-works/pi-agent-core"] !==
      PI_VERSION ||
    sourceManifest.dependencies?.["@earendil-works/pi-ai"] !== PI_VERSION
  )
    throw new Error(
      "The dedicated Flue runtime manifest does not contain the expected exact versions.",
    );

  await run("pnpm", ["--dir", source, "build"]);
  const sourceRuntimeManifest = JSON.parse(
    await readFile(join(source, "runtime-manifest.json"), "utf8"),
  );
  const catalogSource = join(
    projectRoot,
    "src",
    "adapters",
    "pi",
    "pi-ai-catalog.generated.ts",
  );
  await access(catalogSource);
  const catalogText = await readFile(catalogSource, "utf8");
  // Generated TypeScript uses an identifier key after Oxfmt, while older
  // artifacts used a JSON-style quoted key. Accept both textual forms.
  const catalogDigest = /(?:^|[,{}]\s*)"?digest"?\s*:\s*"([a-f0-9]{64})"/m.exec(
    catalogText,
  )?.[1];
  if (sourceRuntimeManifest.catalogDigest !== catalogDigest)
    throw new Error(
      "The generated Pi catalog does not match the runtime manifest.",
    );
  await Promise.all([
    cp(manifest, join(runtimeRoot, "package.json")),
    cp(lockfile, join(runtimeRoot, "pnpm-lock.yaml")),
    cp(dist, runtimeRoot, { recursive: true }),
    cp(catalogSource, join(runtimeRoot, "pi-ai-catalog.generated.ts")),
    cp(
      join(projectRoot, "src", "skills", "patchdesk-code-review"),
      join(runtimeRoot, "skills", "patchdesk-code-review"),
      { recursive: true, dereference: false },
    ),
  ]);
  try {
    await run("pnpm", [
      "--dir",
      runtimeRoot,
      "install",
      "--frozen-lockfile",
      "--prod",
      "--offline",
      "--ignore-scripts",
      "--config.auto-install-peers=false",
    ]);
  } catch (error) {
    throw new Error(
      "The exact locked Flue runtime could not be staged offline. Populate the pnpm store through the normal dependency preparation path, then retry.",
      { cause: error },
    );
  }
  // pnpm 8 links a direct dev-only TypeScript into Valibot's optional peer
  // graph even for --prod, so remove that type-only payload after resolution.
  const nodeModules = join(runtimeRoot, "node_modules");
  const virtualStore = join(nodeModules, ".pnpm");
  const virtualStoreEntries = await readdir(virtualStore, {
    withFileTypes: true,
  }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  await Promise.all([
    rm(join(nodeModules, "typescript"), { recursive: true, force: true }),
    ...virtualStoreEntries
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => [
        ...(entry.name.startsWith("typescript@")
          ? [
              rm(join(virtualStore, entry.name), {
                recursive: true,
                force: true,
              }),
            ]
          : []),
        rm(join(virtualStore, entry.name, "node_modules", "typescript"), {
          recursive: true,
          force: true,
        }),
      ]),
  ]);
  await Promise.all([
    access(join(runtimeRoot, "patchdesk-insight-runner.js")),
    access(join(runtimeRoot, "package-smoke-runner.js")),
    access(join(runtimeRoot, "skills", "patchdesk-code-review", "SKILL.md")),
  ]);
  const lockDigest = createHash("sha256")
    .update(await readFile(join(runtimeRoot, "pnpm-lock.yaml")))
    .digest("hex");
  await writeFile(
    join(runtimeRoot, "runtime-manifest.json"),
    `${JSON.stringify({ piVersion: PI_VERSION, catalogDigest, nodeFloor: NODE_FLOOR, lockDigest })}\n`,
  );
}
