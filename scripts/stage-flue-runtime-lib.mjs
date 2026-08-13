import { access, cp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CLI_VERSION = "1.0.0-beta.9";
const RUNTIME_FILES = [
  "flue-assets.d.ts",
  "flue-runtime-types.ts",
  "flue-routing-types.ts",
];
const RUNTIME_DIRECTORIES = [
  "adapters",
  "domain",
  "services",
  "skills",
  "workflows",
];

/** Stages the locked beta.9 Flue runtime into an Electron resource directory. */
export async function stageFlueRuntime({ projectRoot, runtimeRoot, run }) {
  const sourceRuntimeRoot = join(projectRoot, "runtime", "flue-beta9");
  const manifest = join(sourceRuntimeRoot, "package.json");
  const lockfile = join(sourceRuntimeRoot, "pnpm-lock.yaml");

  await rm(runtimeRoot, { recursive: true, force: true });
  await mkdir(runtimeRoot, { recursive: true });
  await access(manifest);
  await access(lockfile);
  await Promise.all([
    cp(manifest, join(runtimeRoot, "package.json")),
    cp(lockfile, join(runtimeRoot, "pnpm-lock.yaml")),
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
    ]);
  } catch (error) {
    throw new Error(
      "The exact locked Flue runtime could not be staged offline. Populate the pnpm store through the normal dependency preparation path, then retry.",
      { cause: error },
    );
  }

  await Promise.all([
    cp(
      join(projectRoot, "flue.config.ts"),
      join(runtimeRoot, "flue.config.ts"),
    ),
    ...RUNTIME_DIRECTORIES.map(
      async (directory) =>
        await cp(
          join(projectRoot, "src", directory),
          join(runtimeRoot, "src", directory),
          { recursive: true },
        ),
    ),
    ...RUNTIME_FILES.map(
      async (file) =>
        await cp(
          join(projectRoot, "src", file),
          join(runtimeRoot, "src", file),
        ),
    ),
  ]);
  await stageWalkthroughRuntime(runtimeRoot);

  const cli = join(
    runtimeRoot,
    "node_modules",
    "@flue",
    "cli",
    "bin",
    "flue.mjs",
  );
  await access(cli);
  await access(join(runtimeRoot, "flue.config.ts"));
  const version = (await run("node", [cli, "--version"])).trim();
  if (version !== CLI_VERSION) {
    throw new Error(
      `Staged Flue CLI was ${version || "unavailable"}, expected ${CLI_VERSION}.`,
    );
  }
}

async function stageWalkthroughRuntime(runtimeRoot) {
  const walkthroughRoot = join(runtimeRoot, "walkthrough");
  await mkdir(join(walkthroughRoot, "src", "workflows"), { recursive: true });
  await Promise.all([
    cp(
      join(runtimeRoot, "flue.config.ts"),
      join(walkthroughRoot, "flue.config.ts"),
    ),
    writeFile(
      join(walkthroughRoot, "src", "workflows", "generate-walkthrough.ts"),
      'export { default } from "../../../src/workflows/generate-walkthrough";\n',
    ),
    symlink("../node_modules", join(walkthroughRoot, "node_modules"), "dir"),
  ]);
}
