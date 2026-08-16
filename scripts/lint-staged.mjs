#!/usr/bin/env node
// Pre-commit lint gate over staged source files only.
//
// Mirrors the react-doctor staged pattern in package.json "precommit" so a
// commit can proceed while the whole repo still has anti-slop findings: only
// the files being committed must be lint-clean. oxlint --fix applies whatever
// is auto-fixable, then any remaining findings block the commit with the
// rule locations printed.
//
// Custom script; the lint-staged npm package is not used.
import { spawnSync } from "node:child_process";

const LINTABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function run(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
}

function stagedFiles() {
  const result = run("git", [
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACM",
    "-z",
  ]);
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(1);
  }
  return result.stdout.split("\0").filter(Boolean);
}

const files = stagedFiles().filter((file) => LINTABLE.test(file));
if (files.length === 0) {
  process.stdout.write("lint-staged: no staged source files to check.\n");
  process.exit(0);
}

const binDir = new URL("../node_modules/.bin", import.meta.url).pathname;
const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };

process.stdout.write(
  `lint-staged: checking ${files.length} staged file(s) with oxlint --fix...\n`,
);
const lint = spawnSync(
  "oxlint",
  ["--fix", "--deny-warnings", "--no-error-on-unmatched-pattern", ...files],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env },
);

if (lint.status === 0) {
  // Re-stage files whose working tree changed after --fix.
  const changed = files.filter((file) => run("git", ["diff", "--quiet", "--", file]).status === 1);
  if (changed.length > 0) {
    const add = run("git", ["add", ...changed]);
    if (add.status !== 0) {
      process.stderr.write(add.stderr);
      process.exit(1);
    }
    process.stdout.write(
      `lint-staged: re-staged ${changed.length} file(s) after autofix.\n`,
    );
  }
  process.stdout.write("lint-staged: staged files are lint-clean.\n");
  process.exit(0);
}

process.stderr.write(
  "\nlint-staged: staged files have lint findings that oxlint cannot fix.\n",
);
process.stderr.write(
  "Fix them before committing (run pnpm lint on the file, then git add).\n",
);
process.stderr.write(lint.stdout);
process.stderr.write(lint.stderr);
process.exit(1);
