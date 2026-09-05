import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  defaultFileExists as fileExists,
  execute,
  hasExit,
  replay,
} from "./gate-command-lib.mjs";

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const CASK_VERSION_LINE = /^(?<prefix>\s*version ")[^"]*(?=")/gm;
const CASK_SHA256_LINE = /^(?<prefix>\s*sha256 ")[^"]*(?=")/gm;
const TAP_NAME = "kwanpham2195/patchdesk";

/**
 * Point the Homebrew cask at a published release: set `version` and `sha256`
 * in the tap's `Casks/patchdesk.rb` and print the commands that ship it.
 *
 * This writes one file and nothing else. It does not commit or push the tap,
 * for the same reason `release:prepare` does not: the maintainer reads the
 * diff, then runs the printed commands. The checksum is taken from the local
 * `release/` DMG rather than downloaded, because that is the file the
 * maintainer attached to the release in the previous step.
 *
 * @param {{
 *   readonly args: ReadonlyArray<string>;
 *   readonly projectRoot: string;
 *   readonly run: import("./gate-command-lib.mjs").RunCommand;
 *   readonly output: import("./gate-command-lib.mjs").CommandOutput;
 *   readonly env: Readonly<Record<string, string | undefined>>;
 * }} options
 * @returns {Promise<number>} A process-style exit code.
 */
export async function bumpCask({ args, projectRoot, run, output, env }) {
  const version = args[0];
  if (
    args.length !== 1 ||
    version === undefined ||
    !VERSION_PATTERN.test(version)
  ) {
    output.stderr(
      "Usage: pnpm release:cask <version>, for example pnpm release:cask 0.2.0\n",
    );
    return 1;
  }
  const tag = `v${version}`;

  const tapDir = await resolveTapDir({ projectRoot, run, output, env });
  if (tapDir === undefined) return 1;
  const caskPath = join(tapDir, "Casks", "patchdesk.rb");
  if (!(await fileExists(caskPath))) {
    output.stderr(
      `${caskPath} does not exist. Run brew tap ${TAP_NAME}, or set PATCHDESK_TAP_DIR to a checkout of kwanpham2195/homebrew-patchdesk.\n`,
    );
    return 1;
  }

  const status = await execute(
    run,
    "git",
    ["status", "--porcelain"],
    tapDir,
    output,
  );
  if (status === undefined) return 1;
  if (!hasExit(status, 0)) {
    output.stderr("git could not read the tap's working tree status.\n");
    replay(status, output);
    return 1;
  }
  if (status.stdout.trim().length > 0) {
    output.stderr(
      `The tap at ${tapDir} has uncommitted changes. The cask is bumped from a clean tree so its commit holds the version bump and nothing else.\n`,
    );
    output.stderr(status.stdout);
    return 1;
  }

  const release = await execute(
    run,
    "gh",
    ["release", "view", tag, "--json", "isDraft", "--jq", ".isDraft"],
    projectRoot,
    output,
  );
  if (release === undefined) return 1;
  if (!hasExit(release, 0)) {
    output.stderr(
      `GitHub has no release ${tag}. Homebrew fetches the .dmg from the published release URL, so the cask can only point at a release that exists and is published.\n`,
    );
    replay(release, output);
    return 1;
  }
  if (release.stdout.trim() !== "false") {
    output.stderr(
      `Release ${tag} is still a draft. Homebrew fetches the .dmg from the published release URL, so a draft release cannot be installed; publish it first.\n`,
    );
    return 1;
  }

  const dmgPath = join(
    projectRoot,
    "release",
    `Patchdesk-${version}-arm64.dmg`,
  );
  if (!(await fileExists(dmgPath))) {
    output.stderr(
      `${dmgPath} does not exist. Run pnpm package:mac first; the cask's checksum is taken from the .dmg attached to the release.\n`,
    );
    return 1;
  }
  const sha256 = createHash("sha256")
    .update(await readFile(dmgPath))
    .digest("hex");

  const caskText = await readFile(caskPath, "utf8");
  const versionLines = caskText.match(CASK_VERSION_LINE) ?? [];
  const shaLines = caskText.match(CASK_SHA256_LINE) ?? [];
  if (versionLines.length !== 1 || shaLines.length !== 1) {
    output.stderr(
      `${caskPath} must have exactly one \`version "..."\` line and one \`sha256 "..."\` line; found ${versionLines.length} and ${shaLines.length}. Edit it by hand.\n`,
    );
    return 1;
  }

  await writeFile(
    caskPath,
    caskText
      .replace(CASK_VERSION_LINE, `$<prefix>${version}`)
      .replace(CASK_SHA256_LINE, `$<prefix>${sha256}`),
  );

  output.stdout(
    `Bumped the cask to ${version} (sha256 ${sha256}). ${caskPath} is written; nothing is committed or pushed.\n` +
      `\nReview the diff, then run, in ${tapDir}:\n\n` +
      `  git add Casks/patchdesk.rb\n` +
      `  git commit -m "Bump patchdesk to ${version}"\n` +
      `  git push origin main\n` +
      `  brew update && brew audit --cask ${TAP_NAME}/patchdesk && brew upgrade --cask patchdesk\n`,
  );
  return 0;
}

/**
 * The tap checkout to edit: `PATCHDESK_TAP_DIR` when set, otherwise the
 * clone `brew tap` keeps under Homebrew's own directory.
 *
 * @param {{
 *   readonly projectRoot: string;
 *   readonly run: import("./gate-command-lib.mjs").RunCommand;
 *   readonly output: import("./gate-command-lib.mjs").CommandOutput;
 *   readonly env: Readonly<Record<string, string | undefined>>;
 * }} context
 * @returns {Promise<string | undefined>}
 */
async function resolveTapDir({ projectRoot, run, output, env }) {
  const fromEnv = env.PATCHDESK_TAP_DIR;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    const tapDir = fromEnv.trim();
    if (await fileExists(tapDir)) return tapDir;
    output.stderr(
      `PATCHDESK_TAP_DIR points at ${tapDir}, which does not exist. Point it at a checkout of kwanpham2195/homebrew-patchdesk, or unset it and run brew tap ${TAP_NAME}.\n`,
    );
    return undefined;
  }

  const repository = await execute(
    run,
    "brew",
    ["--repository", TAP_NAME],
    projectRoot,
    output,
  );
  if (repository === undefined) return undefined;
  const tapDir = repository.stdout.trim();
  if (!hasExit(repository, 0) || tapDir.length === 0) {
    output.stderr(
      `brew could not locate the ${TAP_NAME} tap. Run brew tap ${TAP_NAME}, or set PATCHDESK_TAP_DIR to a checkout of kwanpham2195/homebrew-patchdesk.\n`,
    );
    replay(repository, output);
    return undefined;
  }
  if (!(await fileExists(tapDir))) {
    output.stderr(
      `The tap directory ${tapDir} does not exist. Run brew tap ${TAP_NAME} to clone it.\n`,
    );
    return undefined;
  }
  return tapDir;
}
