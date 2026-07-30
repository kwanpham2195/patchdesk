import { access, cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const projectRoot = resolve(import.meta.dirname, "..");
const runtimeRoot = join(projectRoot, "out", "workflow-runtime");
const packagedRuntimeRoot = join(
  projectRoot,
  "release",
  "mac-arm64",
  "Patchdesk.app",
  "Contents",
  "Resources",
  "flue-runtime",
);

await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(runtimeRoot, { recursive: true });
await writeFile(join(runtimeRoot, "package.json"), JSON.stringify({
  name: "patchdesk-workflow-runtime",
  private: true,
  type: "module",
  dependencies: { "@flue/cli": "1.0.0-beta.9" },
}, null, 2));

try {
  await run("pnpm", [
    "--dir",
    runtimeRoot,
    "install",
    "--prod",
    "--offline",
    "--ignore-scripts",
  ], { silent: true });
} catch {
  console.log("Using the last verified packaged Flue dependency cache for offline staging.");
  await stagePackagedDependencyCache();
}
await Promise.all([
  cp(join(projectRoot, "flue.config.ts"), join(runtimeRoot, "flue.config.ts")),
  ...["adapters", "domain", "services", "skills", "workflows"].map(async (directory) =>
    await cp(join(projectRoot, "src", directory), join(runtimeRoot, "src", directory), { recursive: true }),
  ),
  ...["flue-assets.d.ts", "flue-runtime-types.ts", "flue-routing-types.ts"].map(async (file) =>
    await cp(join(projectRoot, "src", file), join(runtimeRoot, "src", file)),
  ),
]);
await stageWalkthroughRuntime();

async function stageWalkthroughRuntime() {
  const walkthroughRoot = join(runtimeRoot, "walkthrough");
  await mkdir(join(walkthroughRoot, "src", "workflows"), { recursive: true });
  await Promise.all([
    writeFile(join(walkthroughRoot, "flue.config.ts"), await readFile(join(runtimeRoot, "flue.config.ts"), "utf8")),
    writeFile(
      join(walkthroughRoot, "src", "workflows", "generate-walkthrough.ts"),
      'export { default } from "../../../src/workflows/generate-walkthrough";\n',
    ),
    symlink("../node_modules", join(walkthroughRoot, "node_modules"), "dir").catch(() => undefined),
  ]);
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      shell: false,
      stdio: options.silent === true ? "ignore" : "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code ?? 1}`)));
  });
}

/**
 * A previous locally verified package is an offline cache of the exact Flue
 * dependency closure. Reuse only its dependencies; current source files are
 * copied below. Fresh checkouts still use pnpm's normal install path.
 */
async function stagePackagedDependencyCache() {
  const cachedNodeModules = join(packagedRuntimeRoot, "node_modules");
  try {
    await access(cachedNodeModules);
  } catch {
    throw new Error(
      "Flue runtime dependencies are unavailable offline. Restore npm access or build one package online first.",
    );
  }
  await rm(join(runtimeRoot, "node_modules"), { recursive: true, force: true });
  await cp(cachedNodeModules, join(runtimeRoot, "node_modules"), { recursive: true });
}
