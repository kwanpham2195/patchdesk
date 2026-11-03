#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  execute,
  hasExit,
  processOutput,
  replay,
  spawnCommand,
} from "./gate-command-lib.mjs";
import { testEnvironment } from "./run-full-check.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

const RENDERER_PREFIX = "src/renderer/";

const RENDERER_STAGED_MESSAGE =
  "React Doctor cannot scan: package.json differs between index and worktree, and renderer files are staged. Stage or restore package.json, then retry.\n";

const SKIPPED_MESSAGE =
  "React Doctor skipped: package.json differs between index and worktree. Nothing was scanned.\n";

/**
 * @typedef {{ readonly action: "run" }
 *   | { readonly action: "skip"; readonly message: string }
 *   | { readonly action: "fail"; readonly message: string }} ReactDoctorDecision
 */

/**
 * What the commit gate does about React Doctor.
 *
 * React Doctor aborts when `package.json` differs between the index and
 * working tree, which can reflect another session's edit in this shared
 * checkout rather than this commit. If renderer files are staged, fail because
 * the required scan cannot run; otherwise skip and report that no scan ran.
 * When the file agrees, run React Doctor.
 *
 * @param {{
 *   readonly packageJsonDiffers: boolean;
 *   readonly stagedPaths: ReadonlyArray<string>;
 * }} change
 * @returns {ReactDoctorDecision}
 */
export function decideReactDoctor({ packageJsonDiffers, stagedPaths }) {
  if (!packageJsonDiffers) return { action: "run" };
  if (stagedPaths.some((path) => path.startsWith(RENDERER_PREFIX)))
    return { action: "fail", message: RENDERER_STAGED_MESSAGE };
  return { action: "skip", message: SKIPPED_MESSAGE };
}

const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TSC_CONFIG_INPUT = /^(?:tsconfig[^/]*|[^/]*\.config\.ts)$/;
const LINT_CONFIG_INPUT =
  /^(?:lint-baseline\.json|tools\/oxlint\/|(?:.*\/)?\.oxlintrc\.json$)/;

/**
 * @param {string} path
 * @param {ReadonlyArray<string>} roots
 */
function isUnder(path, roots) {
  return roots.some((root) => path.startsWith(`${root}/`));
}

/**
 * The `pnpm` commands a commit needs, chosen from what it stages. The full
 * `pnpm check` runs at landing instead (CONTRIBUTING.md, "The commit gate").
 * React Doctor is decided separately because it needs the index/worktree check.
 *
 * Staged paths include deletions, so removing a lint config is still seen;
 * only paths that still exist can be handed to `vitest related`.
 *
 * @param {ReadonlyArray<string>} stagedPaths
 * @param {(path: string) => boolean} [exists]
 * @returns {ReadonlyArray<ReadonlyArray<string>>}
 */
export function planStagedChecks(stagedPaths, exists = existsSync) {
  const code = stagedPaths.filter((path) => CODE_FILE.test(path));
  const codeIn = (/** @type {ReadonlyArray<string>} */ roots) =>
    code.some((path) => isUnder(path, roots));
  const staged = (/** @type {ReadonlyArray<string>} */ names) =>
    stagedPaths.some((path) => names.includes(path));

  const markdown = stagedPaths.filter(
    (path) => path.endsWith(".md") && exists(path),
  );
  const related = code.filter(
    (path) => isUnder(path, ["src", "tests", "scripts"]) && exists(path),
  );

  /** @type {Array<ReadonlyArray<string>>} */
  const plan = [["lint:staged"]];
  if (markdown.length > 0) plan.push(["exec", "oxfmt", "--check", ...markdown]);
  // tsc checks JavaScript too (allowJs), so any code under src/ or tests/ counts.
  if (
    codeIn(["src", "tests"]) ||
    stagedPaths.some((path) => TSC_CONFIG_INPUT.test(path)) ||
    staged(["package.json", "pnpm-lock.yaml"])
  )
    plan.push(["typecheck"]);
  if (
    codeIn(["scripts"]) ||
    staged([
      "tsconfig.json",
      "tsconfig.scripts.json",
      "scripts-typecheck-baseline.json",
    ])
  )
    plan.push(["typecheck:scripts"]);
  if (codeIn(["src", "tests", "scripts", "tools"]))
    plan.push(["check:imports"]);
  if (stagedPaths.some((path) => path.startsWith("src/renderer/")))
    plan.push(["check:error-ui"]);
  if (stagedPaths.some((path) => LINT_CONFIG_INPUT.test(path)))
    plan.push(["lint:changed", "--", "origin/main"]);
  if (
    codeIn(["src", "tests", "scripts"]) ||
    staged(["knip.json", "knip-baseline.json", "package.json"])
  )
    plan.push(["knip:ratchet"]);
  if (codeIn(["src"]) || staged(["AGENTS.md", "context-budget.json"]))
    plan.push([
      "exec",
      "vitest",
      "--run",
      "tests/scripts/context-budget.test.ts",
    ]);
  if (related.length > 0)
    plan.push([
      "exec",
      "vitest",
      "related",
      "--run",
      "--passWithNoTests",
      ...related,
    ]);
  return plan;
}

/**
 * Runs one command with the hook's own streams, so its output reaches the
 * terminal as it is produced rather than in one block at the end.
 *
 * @param {string} command
 * @param {ReadonlyArray<string>} args
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<number>}
 */
function runInherited(command, args, cwd, env = process.env) {
  return new Promise((resolveRun) => {
    const child = spawn(command, [...args], { cwd, env, stdio: "inherit" });
    child.once("error", (cause) => {
      process.stderr.write(`${command} could not start: ${cause.message}\n`);
      resolveRun(1);
    });
    child.once("close", (status) => resolveRun(status ?? 1));
  });
}

/**
 * Whether `package.json` differs between the index and the working tree.
 *
 * @param {string} cwd
 * @returns {Promise<boolean | undefined>} `undefined` means git itself failed,
 *   already reported to the output.
 */
async function packageJsonDiffers(cwd) {
  const result = await execute(
    spawnCommand,
    "git",
    ["diff", "--quiet", "--", "package.json"],
    cwd,
    processOutput,
  );
  if (result === undefined) return undefined;
  if (hasExit(result, 0)) return false;
  if (hasExit(result, 1)) return true;
  processOutput.stderr(
    `git could not compare package.json between the index and the working tree (status=${String(result.status)}).\n`,
  );
  replay(result, processOutput);
  return undefined;
}

/**
 * @param {string} cwd
 * @returns {Promise<ReadonlyArray<string> | undefined>}
 */
async function stagedPaths(cwd) {
  const result = await execute(
    spawnCommand,
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACDMR", "-z"],
    cwd,
    processOutput,
  );
  if (result === undefined) return undefined;
  if (!hasExit(result, 0)) {
    processOutput.stderr(
      `git staged-file discovery failed (status=${String(result.status)}).\n`,
    );
    replay(result, processOutput);
    return undefined;
  }
  return result.stdout.split("\u0000").filter((path) => path.length > 0);
}

async function main() {
  const staged = await stagedPaths(projectRoot);
  if (staged === undefined) {
    process.exitCode = 1;
    return;
  }
  const unstaged = await execute(
    spawnCommand,
    "git",
    ["diff", "--name-only", "-z", "--", "*.md"],
    projectRoot,
    processOutput,
  );
  if (unstaged === undefined) {
    process.exitCode = 1;
    return;
  }
  const partialMarkdown = unstaged.stdout
    .split("\u0000")
    .filter((path) => path.length > 0 && staged.includes(path));
  if (partialMarkdown.length > 0) {
    // oxfmt --check reads the working tree, not the index.
    processOutput.stderr(
      "Cannot safely check partially staged Markdown files.\nStage or restore all changes in each listed file, then retry.\n" +
        partialMarkdown.map((path) => `- ${path}`).join("\n") +
        "\n",
    );
    process.exitCode = 1;
    return;
  }
  for (const args of planStagedChecks(staged)) {
    // Test files create their own Git repositories.
    const env = args.includes("vitest")
      ? testEnvironment(projectRoot)
      : process.env;
    const status = await runInherited("pnpm", args, projectRoot, env);
    if (status !== 0) {
      process.exitCode = status;
      return;
    }
  }
  if (!staged.some((path) => path.startsWith("src/"))) return;

  const differs = await packageJsonDiffers(projectRoot);
  if (differs === undefined) {
    process.exitCode = 1;
    return;
  }

  const decision = decideReactDoctor({
    packageJsonDiffers: differs,
    stagedPaths: staged,
  });
  if (decision.action === "fail") {
    processOutput.stderr(decision.message);
    process.exitCode = 1;
    return;
  }
  if (decision.action === "skip") {
    processOutput.stdout(decision.message);
    return;
  }

  process.exitCode = await runInherited(
    "pnpm",
    ["exec", "react-doctor", "--staged", "--blocking", "warning", "--yes"],
    projectRoot,
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  resolve(invokedPath) === fileURLToPath(import.meta.url)
)
  await main();
