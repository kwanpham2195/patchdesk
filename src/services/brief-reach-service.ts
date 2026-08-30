import { realpath } from "node:fs/promises";

import type { CommandRunner } from "../adapters/github/command-runner";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import {
  briefReachFiles,
  removedSymbols,
  summarizeReach,
  MAX_REACH_OUTSIDE_PATHS,
  type BriefReach,
  type BriefReachRemoved,
  type BriefReachSymbol,
  type BriefReachUnavailableReason,
} from "../domain/brief-reach";
import { definedProps } from "../domain/defined-props";
import type { ReviewSessionId, WorkspaceProfileId } from "../domain/ids";

/**
 * The Reach block's counts, from `git grep` over the represented worktree.
 *
 * The model never writes a number: it proposes names, `candidateReachSymbols`
 * keeps only the ones the patch itself carries, and every count here is one
 * `git grep --count` against the immutable head tree. The search is one hop and
 * text-only, which is why the reader labels it "text match".
 *
 * Nothing here throws and nothing here fails a Brief. A worktree that cannot be
 * verified, a search that errors, and a budget that runs out all return
 * `unavailable`, and the Brief is then retained with `reachUnavailable` in the
 * block's place.
 */

/** The whole block's wall-clock budget; a Brief never waits on the search. */
const REACH_BUDGET_MS = 15_000;
/** One `git grep` over a repository of this size is ~0.1 s; this is the outlier bound. */
const MAX_SEARCH_MS = 5_000;
/** `git rev-parse HEAD`, to prove the worktree still stands at the run's revision. */
const HEAD_CHECK_TIMEOUT_MS = 5_000;

export type BriefReachRequest = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
  /** The candidate worktree path; verified against `paths.worktreeDirectory` before use. */
  readonly worktree: string;
  readonly headSha: string;
  readonly patch: string;
  /** Already filtered by `candidateReachSymbols`; each is a plain identifier. */
  readonly symbols: ReadonlyArray<string>;
  readonly signal?: AbortSignal;
};

/** The Brief keeps this in the block's place, so the reader can say why it is missing. */
type BriefReachUnavailable = {
  readonly _tag: "unavailable";
  readonly reason: BriefReachUnavailableReason;
};

export type BriefReachOutcome =
  | { readonly _tag: "ok"; readonly value: BriefReach }
  | BriefReachUnavailable;

/**
 * The seam the Brief validation path calls. It is a function rather than an
 * interface so a test can stand in a fake without a worktree or a `git`.
 */
export type BriefReachComputer = (
  request: BriefReachRequest,
) => Promise<BriefReachOutcome>;

/** Binds the app-owned paths and command runner, leaving one per-run argument. */
export function briefReachComputer(
  paths: PatchdeskPaths,
  runner: Pick<CommandRunner, "runText">,
): BriefReachComputer {
  return (request) => computeBriefReach({ ...request, paths, runner });
}

export type BriefReachInput = BriefReachRequest & {
  readonly paths: PatchdeskPaths;
  readonly runner: Pick<CommandRunner, "runText">;
};

/** Counts one Brief's Reach block; never throws and never rejects. */
export async function computeBriefReach(
  input: BriefReachInput,
): Promise<BriefReachOutcome> {
  try {
    return await countReach(input);
  } catch {
    return unavailable("search_failed");
  }
}

async function countReach(input: BriefReachInput): Promise<BriefReachOutcome> {
  const worktree = await verifiedWorktree(input);
  if (worktree === undefined) return unavailable("worktree_unavailable");
  const deadline = Date.now() + REACH_BUDGET_MS;
  const head = await runGit(
    input,
    worktree,
    ["rev-parse", "HEAD"],
    Math.min(HEAD_CHECK_TIMEOUT_MS, deadline - Date.now()),
  );
  if (head._tag !== "found") return unavailable(searchFailure(head._tag));
  if (head.stdout.trim() !== input.headSha) return unavailable("head_mismatch");

  const files = briefReachFiles(input.patch);
  const changedPaths = new Set(files.map((file) => file.path));
  const symbols: Array<BriefReachSymbol> = [];
  for (const name of input.symbols) {
    const matches = await searchSymbol(input, worktree, name, deadline);
    if (matches._tag === "unavailable") return matches;
    const outside = matches.paths.filter((path) => !changedPaths.has(path));
    symbols.push({
      name,
      outsideCallerFiles: outside.length,
      outsidePaths: outside.slice(0, MAX_REACH_OUTSIDE_PATHS),
      insidePR: outside.length < matches.paths.length,
    });
  }

  const removedStillReferenced: Array<BriefReachRemoved> = [];
  for (const name of removedSymbols(input.patch)) {
    const matches = await searchSymbol(input, worktree, name, deadline);
    if (matches._tag === "unavailable") return matches;
    const outside = matches.paths.filter((path) => !changedPaths.has(path));
    if (outside.length === 0) continue;
    removedStillReferenced.push({
      name,
      paths: outside.slice(0, MAX_REACH_OUTSIDE_PATHS),
    });
  }

  return {
    _tag: "ok",
    value: summarizeReach({ files, symbols, removedStillReferenced }),
  };
}

/** Every file of the head tree that names `name` as a whole word, or why the search stopped. */
type SymbolMatches =
  | { readonly _tag: "matched"; readonly paths: ReadonlyArray<string> }
  | BriefReachUnavailable;

async function searchSymbol(
  input: BriefReachInput,
  worktree: string,
  name: string,
  deadline: number,
): Promise<SymbolMatches> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return unavailable("timed_out");
  const output = await runGit(
    input,
    worktree,
    [
      "grep",
      "--fixed-strings",
      "--word-regexp",
      "--count",
      "-e",
      name,
      input.headSha,
    ],
    Math.min(MAX_SEARCH_MS, remaining),
  );
  if (output._tag === "empty") return { _tag: "matched", paths: [] };
  if (output._tag !== "found") return unavailable(searchFailure(output._tag));
  return { _tag: "matched", paths: matchedPaths(output.stdout, input.headSha) };
}

/**
 * `git grep --count` prints one `<rev>:<path>:<count>` line per matching file.
 * A path may itself contain a colon, so the count is split from the right.
 */
function matchedPaths(stdout: string, rev: string): ReadonlyArray<string> {
  const paths: Array<string> = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(`${rev}:`)) continue;
    const rest = line.slice(rev.length + 1);
    const cut = rest.lastIndexOf(":");
    if (cut <= 0) continue;
    const count = Number(rest.slice(cut + 1));
    if (!Number.isInteger(count) || count <= 0) continue;
    paths.push(rest.slice(0, cut));
  }
  return paths;
}

/** How one `git` run ended, in the three shapes this service distinguishes. */
type GitOutcome =
  | { readonly _tag: "found"; readonly stdout: string }
  /** Exit 1 with nothing on stderr: `git grep` found no match, which is a count of zero. */
  | { readonly _tag: "empty" }
  | { readonly _tag: "timed_out" }
  | { readonly _tag: "failed" };

async function runGit(
  input: BriefReachInput,
  worktree: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<GitOutcome> {
  if (timeoutMs <= 0) return { _tag: "timed_out" };
  const result = await input.runner.runText({
    argv: ["git", "--no-replace-objects", "-C", worktree, ...args],
    cwd: worktree,
    timeoutMs,
    ...definedProps({ signal: input.signal }),
  });
  if (result._tag === "ok") return { _tag: "found", stdout: result.value };
  if (result.error._tag === "CommandTimedOut") return { _tag: "timed_out" };
  // A nonzero exit that said nothing is `git grep`'s "no match", not a failure.
  return result.error._tag === "CommandFailed" && result.error.stderr === ""
    ? { _tag: "empty" }
    : { _tag: "failed" };
}

/**
 * The candidate worktree resolved to the same real path as this session's
 * app-owned worktree, mirroring `CodexInsightInvoker`'s guard: nothing outside
 * `paths.worktreeDirectory` is ever searched.
 */
async function verifiedWorktree(
  input: BriefReachInput,
): Promise<string | undefined> {
  const expected = input.paths.worktreeDirectory(
    input.profileId,
    input.sessionId,
  );
  const [candidate, owned] = await Promise.all([
    realpath(input.worktree).catch(() => undefined),
    realpath(expected).catch(() => undefined),
  ]);
  if (candidate === undefined || owned === undefined) return undefined;
  return candidate === owned ? candidate : undefined;
}

function searchFailure(
  outcome: "timed_out" | "failed" | "empty",
): BriefReachUnavailableReason {
  return outcome === "timed_out" ? "timed_out" : "search_failed";
}

function unavailable(
  reason: BriefReachUnavailableReason,
): BriefReachUnavailable {
  return { _tag: "unavailable", reason };
}
