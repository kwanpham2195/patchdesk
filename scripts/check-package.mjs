#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheckCommand } from "./run-full-check.mjs";

/**
 * Check an explicitly selected package; unknown or absent selections fail closed.
 * Root owns application tests and lint-plugin validation, not the separate runtime suite.
 * @param {ReadonlyArray<string>} packages
 * @param {string} cwd
 * @param {AbortSignal} signal
 * @param {typeof runCheckCommand} [run]
 * @returns {Promise<number>}
 */
export async function checkPackages(
  packages,
  cwd,
  signal,
  run = runCheckCommand,
) {
  if (
    packages.length === 0 ||
    packages.some((name) => name !== "root" && name !== "insight")
  ) {
    process.stderr.write(
      "Usage: pnpm check:package root|insight [root|insight]\n",
    );
    return 2;
  }
  for (const name of new Set(packages)) {
    const commands =
      name === "root"
        ? [
            ["typecheck"],
            ["typecheck:scripts"],
            ["check:error-ui"],
            ["check:imports"],
            ["test:root"],
            [
              "exec",
              "oxlint",
              "--deny-warnings",
              "--ignore-pattern",
              "runtime/insight/**",
            ],
          ]
        : [
            ["--dir", "runtime/insight", "typecheck"],
            ["exec", "oxlint", "--deny-warnings", "runtime/insight"],
            ["test:insight"],
          ];
    for (const args of commands) {
      const status = await run("pnpm", args, cwd, signal);
      if (status !== 0) return status;
    }
  }
  return 0;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    process.exitCode = await checkPackages(
      process.argv.slice(2),
      resolve(import.meta.dirname, ".."),
      controller.signal,
    );
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
