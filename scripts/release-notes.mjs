#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read one release's body out of a changelog, as the release notes.
 *
 * The maintainer already wrote and reviewed that entry, so the draft release
 * quotes it rather than generating a list of commit subjects. Returns
 * `undefined` when the version has no heading at all, and `""` when the
 * heading is there but holds nothing: a release with no notes is a mistake
 * worth stopping for, not an empty release page.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {string | undefined}
 */
export function extractReleaseNotes(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex(
    (line) => line.startsWith("## ") && headingVersion(line) === version,
  );
  if (start === -1) return undefined;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

/**
 * The version a `## 0.1.3 - 2026-09-01` heading names, without its date.
 *
 * @param {string} line
 * @returns {string}
 */
function headingVersion(line) {
  const heading = line.slice("## ".length).trim();
  const separator = heading.indexOf(" - ");
  return separator === -1 ? heading : heading.slice(0, separator).trim();
}

function main() {
  const root = resolve(import.meta.dirname, "..");
  const version = process.argv[2];
  if (version === undefined || version.trim().length === 0) {
    process.stderr.write(
      "Usage: pnpm release:notes <version>, for example pnpm release:notes 0.2.0\n",
    );
    process.exitCode = 2;
    return;
  }

  const notes = extractReleaseNotes(
    readFileSync(resolve(root, "CHANGELOG.md"), "utf8"),
    version,
  );
  if (notes === undefined || notes.length === 0) {
    process.stderr.write(
      `CHANGELOG.md has no entries under \`## ${version}\`. Run pnpm release:prepare ${version} and write the release's changelog entry before tagging it.\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${notes}\n`);
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  resolve(invokedPath) === fileURLToPath(import.meta.url)
)
  main();
