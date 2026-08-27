import { basename } from "node:path";

import {
  defaultFileExists,
  describeCause,
  execute,
  hasExit,
  pinnedTool,
  replay,
} from "./gate-command-lib.mjs";

/**
 * @typedef {import("./gate-command-lib.mjs").CommandOutput} CommandOutput
 */

/**
 * @typedef {import("./gate-command-lib.mjs").RunCommand} RunCommand
 */

/**
 * `revision` names the git revision holding the change under test: `""` is
 * git's own syntax for the index, and a commit SHA is used in CI.
 * `changedPaths` lists every repo-root-relative path that change touches.
 *
 * @typedef {{
 *   readonly cwd: string;
 *   readonly run: RunCommand;
 *   readonly revision: string;
 *   readonly changedPaths: ReadonlyArray<string>;
 *   readonly fileExists?: (path: string) => Promise<boolean>;
 *   readonly output: CommandOutput;
 * }} RatchetOptions
 */

/**
 * @typedef {{
 *   readonly label: string;
 *   readonly subject: string;
 *   readonly baselineFile: string;
 *   readonly baselineField: string;
 *   readonly configLabel: string;
 *   readonly isConfigPath: (path: string) => boolean;
 *   readonly tool: string;
 *   readonly toolArgs: ReadonlyArray<string>;
 *   readonly countIssues: (
 *     stdout: string,
 *     output: CommandOutput,
 *   ) => number | undefined;
 * }} RatchetSpec
 */

/** @type {RatchetSpec} */
const OXLINT_RATCHET = {
  label: "Oxlint",
  subject: "Oxlint findings",
  baselineFile: "lint-baseline.json",
  baselineField: "findings",
  configLabel: ".oxlintrc.json",
  isConfigPath: isOxlintConfigPath,
  tool: "oxlint",
  toolArgs: ["--deny-warnings", "--format=json"],
  countIssues: countOxlintFindings,
};

/** @type {RatchetSpec} */
const KNIP_RATCHET = {
  label: "Knip",
  subject: "Knip issues",
  baselineFile: "knip-baseline.json",
  baselineField: "issues",
  configLabel: "knip.json",
  isConfigPath: (path) => basename(path) === "knip.json",
  tool: "knip",
  toolArgs: ["--reporter", "json", "--no-exit-code"],
  countIssues: countKnipIssues,
};

/**
 * Compare the repo-wide Oxlint finding count with the baseline recorded in
 * `lint-baseline.json`, as the change under test would commit it.
 *
 * @param {RatchetOptions} options
 * @returns {Promise<number>} A process-style exit code.
 */
export async function checkLintRatchet(options) {
  return runCountRatchet(OXLINT_RATCHET, options);
}

/**
 * Compare the repo-wide Knip issue count with the baseline recorded in
 * `knip-baseline.json`, as the change under test would commit it.
 *
 * @param {RatchetOptions} options
 * @returns {Promise<number>} A process-style exit code.
 */
export async function checkKnipRatchet(options) {
  return runCountRatchet(KNIP_RATCHET, options);
}

/**
 * One count ratchet: run a whole-repository tool, count what it reports, and
 * compare that count with the baseline number the change under test commits.
 *
 * Three rules, in order:
 *
 * 1. The baseline is read with `git show <revision>:<file>`, never from the
 *    working tree. `revision` is `""` for the staged change (git's own syntax
 *    for reading the index) and a commit SHA in CI. So an edit to the
 *    baseline file that was never staged reads as the OLD number, which is
 *    what makes "update the baseline in the same commit" an enforceable rule
 *    rather than advice.
 * 2. Changing the tool's configuration while the baseline file is absent from
 *    the change under test fails, before the tool is paid for. "Absent" is
 *    read off the change's own path list, so staging the baseline unchanged
 *    does not satisfy it. See `checkConfigChange` for what this rule does and
 *    does not catch.
 * 3. A count above the baseline fails (new findings). A count BELOW the
 *    baseline also fails, and asks for the baseline to be lowered to match.
 *    A drop that nobody records is a drop that can drift back up unnoticed.
 *
 * Rule 2 runs first: it is the cheapest of the three, and when a config
 * change arrives without a baseline it names that specific problem instead of
 * letting rule 1 report the same tree with a more general message.
 *
 * The count covers the whole working tree, uncommitted edits included, since
 * that is what the tools read. The failure messages say so.
 *
 * @param {RatchetSpec} spec
 * @param {RatchetOptions} options
 * @returns {Promise<number>} A process-style exit code.
 */
async function runCountRatchet(
  spec,
  { cwd, run, revision, changedPaths, fileExists = defaultFileExists, output },
) {
  const configResult = checkConfigChange(spec, revision, changedPaths, output);
  if (configResult !== 0) return configResult;

  const baseline = await readBaselineAtRevision(spec, revision, {
    cwd,
    run,
    output,
  });
  if (baseline === undefined) return 1;

  const tool = await pinnedTool(spec.tool, cwd, fileExists, output);
  if (tool === undefined) return 1;

  const result = await execute(run, tool, spec.toolArgs, cwd, output);
  if (result === undefined) return 1;
  if (result.signal !== null) {
    output.stderr(
      `${spec.label} (repo-wide) exited via signal ${result.signal}.\n`,
    );
    replay(result, output);
    return 1;
  }

  const count = spec.countIssues(result.stdout, output);
  if (count === undefined) {
    replay(result, output);
    return 1;
  }
  return reportCount(spec, baseline, count, output);
}

/**
 * Rule 2: the configuration gate. A change that touches the tool's
 * configuration while the baseline file is absent from the change under test
 * is rejected before the tool is paid for.
 *
 * "Absent from the change" is decided from `changedPaths`, which is the
 * change itself: `git diff --cached --name-only` for the staged shape and
 * `git diff --name-only <base>...<head>` for the commit shape. Asking the
 * change is the only question with an answer that varies. An earlier form
 * asked `git ls-files --stage` / `git ls-tree` whether the baseline was
 * PRESENT, reasoning that "staged unchanged" and "never touched" look alike
 * to git -- but a tracked file is present unconditionally, so that test was
 * true for every change and the gate never fired. It could only reject a
 * change that DELETED the baseline from the repository, which is not what a
 * rule-loosening change does.
 *
 * The price of asking the change is that staging the baseline unchanged no
 * longer satisfies the rule, because it leaves no diff entry to see. A
 * configuration edit that moves no count -- a rule nothing violates, a
 * `tools/oxlint/LICENSE` line -- must therefore still write something into
 * the baseline file. That is deliberate: the baseline carries a `note`
 * describing what its number counts, and an edit that changes which rules
 * produce that number changes what the note describes. Recording "recounted,
 * still N" there is the reviewable act this rule exists to force, and it is
 * cheaper than a gate that cannot fire.
 *
 * What this rule does NOT catch, and cannot: a change that loosens five
 * findings away and adds five new ones nets to the same count, so the
 * baseline is genuinely correct and rule 3 passes it. A count is a count; no
 * gate reading one number can tell netting from no change. Catching that
 * needs a baseline of finding identities, not of finding totals.
 *
 * @param {RatchetSpec} spec
 * @param {string} revision
 * @param {ReadonlyArray<string>} changedPaths
 * @param {CommandOutput} output
 * @returns {number} A process-style exit code.
 */
function checkConfigChange(spec, revision, changedPaths, output) {
  const paths = changedPaths.filter((path) => path.length > 0);
  if (!paths.some(spec.isConfigPath)) return 0;
  if (paths.includes(spec.baselineFile)) return 0;

  const carried = revision === "" ? "staged" : "committed";
  output.stderr(
    `${spec.configLabel} changed but ${spec.baselineFile} is not ${carried} in this change.\n` +
      `Loosening a rule silently lowers the ${spec.subject} count, and the ratchet ` +
      `would then accept the new lower number as the truth. ` +
      `Recount, set "${spec.baselineField}" in ${spec.baselineFile} to the new number, ` +
      `and ${carried === "staged" ? "stage" : "commit"} ${spec.baselineFile} in this same change ` +
      `so the two are reviewed together.\n` +
      `${carried === "staged" ? "Staging" : "Committing"} ${spec.baselineFile} unchanged does not count: ` +
      `it leaves no diff entry, so nothing tells this change apart from one that never touched the file. ` +
      `When the recount lands on the same number, say so in the "note" field.\n`,
  );
  return 1;
}

/**
 * Rule 3: the count gate.
 *
 * @param {RatchetSpec} spec
 * @param {number} baseline
 * @param {number} count
 * @param {CommandOutput} output
 * @returns {number} A process-style exit code.
 */
function reportCount(spec, baseline, count, output) {
  if (count > baseline) {
    output.stderr(
      `Repo-wide ${spec.subject} rose from ${baseline} to ${count}.\n` +
        `${spec.baselineFile} blocks new findings above the recorded count. ` +
        `Fix the new finding(s), or raise "${spec.baselineField}" in ${spec.baselineFile} ` +
        `only when the increase is deliberate and reviewed.\n` +
        `${countScopeNote(spec)}\n`,
    );
    return 1;
  }

  if (count < baseline) {
    output.stderr(
      `Repo-wide ${spec.subject} fell from ${baseline} to ${count}.\n` +
        `Set "${spec.baselineField}" in ${spec.baselineFile} to ${count} and stage that file ` +
        `in this same change, so the improvement is locked in. An unrecorded drop lets the ` +
        `count drift back up with nothing to stop it.\n` +
        `${countScopeNote(spec)}\n`,
    );
    return 1;
  }

  output.stdout(
    `Repo-wide ${spec.subject} unchanged at ${count} (see ${spec.baselineFile}).\n`,
  );
  return 0;
}

/**
 * @param {RatchetSpec} spec
 * @returns {string}
 */
function countScopeNote(spec) {
  return (
    `${spec.label} reads the whole working tree, so unstaged edits count too. ` +
    `If unstaged work moved the number, commit or set that work aside rather than ` +
    `moving the baseline to match it.`
  );
}

/**
 * Read the baseline number out of the change under test, never out of the
 * working tree. See `runCountRatchet`'s rule 1.
 *
 * @param {RatchetSpec} spec
 * @param {string} revision
 * @param {{
 *   readonly cwd: string;
 *   readonly run: RunCommand;
 *   readonly output: CommandOutput;
 * }} context
 * @returns {Promise<number | undefined>}
 */
async function readBaselineAtRevision(spec, revision, { cwd, run, output }) {
  const where = describeRevision(revision);
  const result = await execute(
    run,
    "git",
    ["show", `${revision}:${spec.baselineFile}`],
    cwd,
    output,
  );
  if (result === undefined) return undefined;
  if (!hasExit(result, 0)) {
    // "staged" is the right word only for the index. When the change under
    // test is a commit, the baseline had to be committed, not staged.
    const carried = revision === "" ? "staged" : "committed at that revision";
    output.stderr(
      `Could not read ${spec.baselineFile} at ${where} (status=${String(result.status)}).\n` +
        `The ratchet reads the baseline as the change under test would commit it, ` +
        `so a new or edited ${spec.baselineFile} must be ${carried} before it counts.\n`,
    );
    if (result.stderr.length > 0) output.stderr(result.stderr);
    return undefined;
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (cause) {
    output.stderr(
      `${spec.baselineFile} at ${where} is not valid JSON: ${describeCause(cause)}\n`,
    );
    return undefined;
  }

  const value = Object(parsed)[spec.baselineField];
  if (!Number.isInteger(value) || value < 0) {
    output.stderr(
      `${spec.baselineFile} must have a non-negative integer "${spec.baselineField}" field.\n`,
    );
    return undefined;
  }
  return value;
}

/** `""` is git's own syntax for the index, which is what a commit gate tests. */
function describeRevision(revision) {
  return revision === "" ? "the staged index" : `commit ${revision}`;
}

/**
 * Any `.oxlintrc.json`, at the repository root or nested, plus the Oxlint
 * plugin sources under `tools/oxlint/`. Weakening a rule written in plugin
 * JavaScript lowers the count exactly the way weakening one written in the
 * config file does.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isOxlintConfigPath(path) {
  return (
    basename(path) === ".oxlintrc.json" || path.startsWith("tools/oxlint/")
  );
}

/**
 * @param {string} stdout
 * @param {CommandOutput} output
 * @returns {number | undefined}
 */
function countOxlintFindings(stdout, output) {
  const parsed = parseToolJson(stdout, "Oxlint", output);
  if (parsed === undefined) return undefined;
  const diagnostics = Object(parsed).diagnostics;
  if (!Array.isArray(diagnostics)) {
    output.stderr(
      "Oxlint (repo-wide) JSON output is missing a diagnostics array.\n",
    );
    return undefined;
  }
  return diagnostics.length;
}

/**
 * Knip's JSON reporter groups issues per file, one array per issue kind
 * (`files`, `exports`, `types`, `dependencies`, and so on). The ratchet's
 * number is every entry of every one of those arrays.
 *
 * @param {string} stdout
 * @param {CommandOutput} output
 * @returns {number | undefined}
 */
function countKnipIssues(stdout, output) {
  const parsed = parseToolJson(stdout, "Knip", output);
  if (parsed === undefined) return undefined;
  const issues = Object(parsed).issues;
  if (!Array.isArray(issues)) {
    output.stderr("Knip (repo-wide) JSON output is missing an issues array.\n");
    return undefined;
  }
  let total = 0;
  for (const entry of issues) {
    for (const value of Object.values(Object(entry))) {
      if (Array.isArray(value)) total += value.length;
    }
  }
  return total;
}

function parseToolJson(stdout, label, output) {
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    output.stderr(
      `${label} (repo-wide) did not return parseable JSON: ${describeCause(cause)}\n`,
    );
    return undefined;
  }
}
