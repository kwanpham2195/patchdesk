import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { execute, hasExit, replay } from "./gate-command-lib.mjs";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const UNRELEASED_HEADING = /^## Unreleased[^\n\S]*$/m;
// The first `"version"` key in `package.json` is the package's own; the
// dependency versions below it are values, not keys, so they cannot match.
const PACKAGE_VERSION = /^(?<prefix>\s*"version":\s*")[^"]*(?=")/m;

/**
 * Prepare the working tree for a release: set the version, close the
 * changelog's Unreleased section, and print the commands that publish it.
 *
 * This writes two files and nothing else. It does not commit, tag, or push,
 * because a release is worth reading before it is published: the maintainer
 * reviews the diff, then runs the printed commands. Pushing the tag is what
 * starts the `Release` workflow.
 *
 * @param {{
 *   readonly args: ReadonlyArray<string>;
 *   readonly projectRoot: string;
 *   readonly today: Date;
 *   readonly run: import("./gate-command-lib.mjs").RunCommand;
 *   readonly output: import("./gate-command-lib.mjs").CommandOutput;
 * }} options
 * @returns {Promise<number>} A process-style exit code.
 */
export async function prepareRelease({
  args,
  projectRoot,
  today,
  run,
  output,
}) {
  const version = args[0];
  if (
    args.length !== 1 ||
    version === undefined ||
    !VERSION_PATTERN.test(version)
  ) {
    output.stderr(
      "Usage: pnpm release:prepare <version>, for example pnpm release:prepare 0.2.0\n",
    );
    return 2;
  }
  const tag = `v${version}`;

  const status = await execute(
    run,
    "git",
    ["status", "--porcelain"],
    projectRoot,
    output,
  );
  if (status === undefined) return 1;
  if (!hasExit(status, 0)) {
    output.stderr("git could not read the working tree status.\n");
    replay(status, output);
    return 1;
  }
  if (status.stdout.trim().length > 0) {
    output.stderr(
      "The working tree has uncommitted changes. A release is prepared from a clean tree so its commit holds the version bump and nothing else.\n",
    );
    output.stderr(status.stdout);
    return 1;
  }

  const existingTag = await execute(
    run,
    "git",
    // `--list` takes a glob; the version pattern above admits only digits,
    // dots, and hyphens, so this matches the one literal tag name.
    ["tag", "--list", tag],
    projectRoot,
    output,
  );
  if (existingTag === undefined) return 1;
  if (!hasExit(existingTag, 0)) {
    output.stderr("git could not list the existing tags.\n");
    replay(existingTag, output);
    return 1;
  }
  if (existingTag.stdout.trim().length > 0) {
    output.stderr(
      `Tag ${tag} already exists. Releases are never re-cut under a tag that has shipped; choose the next version.\n`,
    );
    return 1;
  }

  const packagePath = join(projectRoot, "package.json");
  const changelogPath = join(projectRoot, "CHANGELOG.md");
  const [packageText, changelogText] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(changelogPath, "utf8"),
  ]);
  if (!PACKAGE_VERSION.test(packageText)) {
    output.stderr("package.json has no top-level version field to set.\n");
    return 1;
  }
  if (!UNRELEASED_HEADING.test(changelogText)) {
    output.stderr(
      "CHANGELOG.md has no `## Unreleased` heading, so there is nothing to release under this version.\n",
    );
    return 1;
  }

  // Both files are rewritten only once both have passed, so a rejected
  // release leaves the tree exactly as it was found.
  await Promise.all([
    writeFile(
      packagePath,
      packageText.replace(PACKAGE_VERSION, `$<prefix>${version}`),
    ),
    writeFile(
      changelogPath,
      changelogText.replace(
        UNRELEASED_HEADING,
        `## Unreleased\n\n## ${version} - ${isoDate(today)}`,
      ),
    ),
  ]);

  output.stdout(
    `Prepared ${version}. package.json and CHANGELOG.md are written; nothing is committed, tagged, or pushed.\n` +
      `\nReview the diff, then run:\n\n` +
      `  git add package.json CHANGELOG.md\n` +
      `  git commit -m "chore: release ${version}"\n` +
      `  git tag ${tag}\n` +
      `  git push origin main ${tag}\n` +
      `\nPushing the tag runs the Release workflow, which builds the macOS package and opens a draft GitHub release for you to publish.\n`,
  );
  return 0;
}

/**
 * The calendar date where the release is being prepared, as `YYYY-MM-DD`.
 *
 * @param {Date} date
 * @returns {string}
 */
function isoDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
