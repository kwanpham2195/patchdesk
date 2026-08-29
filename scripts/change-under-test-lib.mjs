/**
 * The change a quality ratchet is testing: which git revision holds it, and
 * which repo-root-relative paths it touches. Every ratchet entry script asks
 * this same question, and answers it the same two ways.
 *
 * `check-knip-ratchet.mjs` owned this alone until `check-scripts-types.mjs`
 * needed the same pair of shapes.
 */

import {
  execute,
  hasExit,
  replay,
  resolveCommitRef,
} from "./gate-command-lib.mjs";

/**
 * @typedef {import("./gate-command-lib.mjs").CommandOutput} CommandOutput
 */

/**
 * @typedef {import("./gate-command-lib.mjs").RunCommand} RunCommand
 */

/**
 * The change a ratchet is testing: which revision holds it, and which paths it
 * touches. With no arguments that is the staged change, so one invocation
 * works from `pnpm check` and from a commit hook. With a base and a head it is
 * that commit pair, which is the shape CI uses.
 *
 * @param {ReadonlyArray<string>} args
 * @param {{
 *   readonly cwd: string;
 *   readonly run: RunCommand;
 *   readonly output: CommandOutput;
 * }} context
 * @returns {Promise<{
 *   readonly revision: string;
 *   readonly changedPaths: ReadonlyArray<string>;
 * } | undefined>}
 */
export async function resolveChangeUnderTest(args, { cwd, run, output }) {
  return args.length === 0
    ? stagedChange({ cwd, run, output })
    : commitRangeChange(args, { cwd, run, output });
}

/**
 * The staged change. `git diff --cached` needs no history at all, so this
 * works on the very first commit in a repository as well as in a shallow
 * clone, where `HEAD~1` does not exist.
 */
async function stagedChange({ cwd, run, output }) {
  const args = ["diff", "--cached", "--name-only", "--diff-filter=ACDMR", "-z"];
  const result = await execute(run, "git", args, cwd, output);
  if (result === undefined) return undefined;
  if (!hasExit(result, 0)) {
    output.stderr(
      `git staged-file discovery failed (status=${String(result.status)}).\n`,
    );
    replay(result, output);
    return undefined;
  }
  return { revision: "", changedPaths: splitPaths(result.stdout) };
}

async function commitRangeChange(args, { cwd, run, output }) {
  const [baseRef, headRef] = args;
  const base = await resolveCommitRef(baseRef, "base", { cwd, run, output });
  if (base === undefined) return undefined;
  const head = await resolveCommitRef(headRef, "head", { cwd, run, output });
  if (head === undefined) return undefined;

  const result = await execute(
    run,
    "git",
    ["diff", "--name-only", "--diff-filter=ACDMR", "-z", `${base}...${head}`],
    cwd,
    output,
  );
  if (result === undefined) return undefined;
  if (!hasExit(result, 0)) {
    output.stderr(
      `git changed-file discovery failed (status=${String(result.status)}).\n`,
    );
    replay(result, output);
    return undefined;
  }
  return { revision: head, changedPaths: splitPaths(result.stdout) };
}

function splitPaths(stdout) {
  return stdout.split("\0").filter((path) => path.length > 0);
}
