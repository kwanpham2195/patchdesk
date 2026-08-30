import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { resolveMacSigningEnvironment } from "./package-mac-lib.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const signing = resolveMacSigningEnvironment(process.env);
process.stdout.write(`${signing.summary}\n`);

// Spawns `pnpm run electron-builder:mac` rather than importing
// electron-builder and calling its programmatic `build()` API directly:
// electron-builder 26.15.3 ships broken `.d.ts` files, and
// `tsconfig.scripts.json` runs with `skipLibCheck` off on purpose, so
// importing the package here fails `pnpm typecheck:scripts`. Naming the tool
// in `package.json` instead of spawning it by path also keeps it visible to
// Knip, which reads scripts out of `package.json` and cannot see a binary
// invoked from inside a script.
const status = await run("pnpm", ["run", "electron-builder:mac"]);
// Assigned inside the conditional on purpose: a top-level `process.exitCode =
// ...` in a `.mjs` file reads to TypeScript as a redeclared export of Node's
// own `exitCode`, which the `scripts/` type ratchet counts as an error. See
// scripts/prepare-release.mjs.
if (status !== 0) process.exitCode = status;

/**
 * @param {string} command
 * @param {ReadonlyArray<string>} args
 * @returns {Promise<number>}
 */
function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: signing.environment,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} was terminated by signal ${signal}`));
        return;
      }
      resolveRun(code ?? 1);
    });
  });
}
