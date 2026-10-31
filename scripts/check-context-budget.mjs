#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

import {
  BUDGET_FILE,
  findGrowth,
  hasIncreaseTrailer,
  measureContextBudget,
  renderBudget,
} from "./context-budget-lib.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

const USAGE =
  "Usage: node scripts/check-context-budget.mjs --write | --ci | --commit-msg <message-file>\n";

/**
 * @param {string} spec A `git show` object, such as `HEAD:context-budget.json`.
 * @returns {Record<string, number> | undefined} `undefined` when there is no such object.
 */
function budgetAt(spec) {
  try {
    return JSON.parse(
      execFileSync("git", ["show", spec], {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return undefined;
  }
}

/** Measures with the sources loaded through Vite, which resolves their extensionless imports. */
async function measure() {
  const server = await createServer({
    configFile: false,
    root: projectRoot,
    logLevel: "silent",
    appType: "custom",
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  });
  try {
    return await measureContextBudget(
      (path) => server.ssrLoadModule(`/${path}`),
      projectRoot,
    );
  } finally {
    await server.close();
  }
}

/**
 * @param {ReadonlyArray<string>} lines
 * @param {string} reason
 */
function reportGrowth(lines, reason) {
  process.stderr.write(
    `Model-facing text grew${reason}:\n${lines.map((line) => `- ${line}`).join("\n")}\n` +
      `Add a message line "context-increase: <reason>" to allow it, and update ${BUDGET_FILE} (node scripts/check-context-budget.mjs --write).\n`,
  );
}

/**
 * @param {ReadonlyArray<string>} args
 * @returns {Promise<number>} A process-style exit code.
 */
async function run(args) {
  const [mode, messageFile] = args;
  if (mode === "--write" && args.length === 1) {
    await writeFile(
      resolve(projectRoot, BUDGET_FILE),
      renderBudget(await measure()),
    );
    return 0;
  }

  if (mode === "--ci" && args.length === 1) {
    const growth = findGrowth(
      JSON.parse(await readFile(resolve(projectRoot, BUDGET_FILE), "utf8")),
      await measure(),
    );
    if (growth.length === 0) return 0;
    const message = execFileSync("git", ["log", "-1", "--format=%B"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    if (hasIncreaseTrailer(message)) return 0;
    reportGrowth(growth, " past the committed budget");
    return 1;
  }

  if (mode === "--commit-msg" && messageFile !== undefined) {
    const measured = await measure();
    // The commit that introduces the budget has nothing to grow from.
    const committed = budgetAt(`HEAD:${BUDGET_FILE}`);
    if (committed === undefined) return 0;
    const growth = findGrowth(committed, measured);
    if (growth.length === 0) return 0;
    const message = await readFile(resolve(messageFile), "utf8");
    if (!hasIncreaseTrailer(message)) {
      reportGrowth(growth, " since HEAD");
      return 1;
    }
    const staged = budgetAt(`:${BUDGET_FILE}`) ?? {};
    if (
      findGrowth(measured, staged).length > 0 ||
      findGrowth(staged, measured).length > 0
    ) {
      process.stderr.write(
        `${BUDGET_FILE} in the index differs from the measured sizes. Update and stage it: node scripts/check-context-budget.mjs --write\n`,
      );
      return 1;
    }
    return 0;
  }

  process.stderr.write(USAGE);
  return 2;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  resolve(invokedPath) === fileURLToPath(import.meta.url)
)
  process.exitCode = await run(process.argv.slice(2));
