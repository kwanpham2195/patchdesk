import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import type { CommandRunner } from "../adapters/github/command-runner";
import { isPathContained } from "../adapters/storage/path-containment";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import {
  briefReachFiles,
  candidateReachSymbols,
  newlyDeclaredNames,
  removedSymbols,
  summarizeReach,
  MAX_REACH_OUTSIDE_PATHS,
  type BriefReach,
  type BriefReachRemoved,
  type BriefReachSymbol,
  type BriefReachUnavailableReason,
} from "../domain/brief-reach";
import {
  enclosingDeclaration,
  mentionKind,
  MAX_MENTIONS_PER_NAME,
  MAX_MENTIONS_TOTAL,
  MENTION_KIND_ORDER,
  type BriefReachMention,
  type BriefReachMentionKind,
} from "../domain/brief-reach-mentions";
import { definedProps } from "../domain/defined-props";
import type { ReviewSessionId, WorkspaceProfileId } from "../domain/ids";

/**
 * The Reach block's counts, from `git grep` over the represented worktree.
 *
 * The model never writes a number: it proposes names, `candidateReachSymbols`
 * keeps only the ones the patch itself changes, and every count here is one
 * `git grep` against the immutable head tree. The search is one hop and
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

/** A mention in prose is not a caller: keep the Reach search out of docs and other non-code text. */
const REACH_EXCLUDED_PATHSPECS: ReadonlyArray<string> = [
  ":(exclude)*.md",
  ":(exclude)*.mdx",
  ":(exclude)*.txt",
  ":(exclude)*.rst",
  ":(exclude)docs/",
];

export type BriefReachRequest = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
  /** The candidate worktree path; verified against `paths.worktreeDirectory` before use. */
  readonly worktree: string;
  readonly headSha: string;
  readonly patch: string;
  /** The child's proposed names, unfiltered; `candidateReachSymbols` decides which are counted. */
  readonly proposed: ReadonlyArray<string>;
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
  const newNames = newlyDeclaredNames(input.patch);
  const headLines = await readWorktreeFiles(worktree, [...changedPaths]);
  const searched: Array<{
    readonly name: string;
    readonly outside: ReadonlyArray<MatchedLine>;
    readonly insidePR: boolean;
  }> = [];
  for (const name of candidateReachSymbols(
    input.patch,
    input.proposed,
    headLines,
  )) {
    const matches = await searchSymbol(input, worktree, name, deadline);
    if (matches._tag === "unavailable") return matches;
    const outside = matches.lines.filter(
      (line) => !changedPaths.has(line.path),
    );
    searched.push({
      name,
      outside,
      insidePR: outside.length < matches.lines.length,
    });
  }

  const removed: Array<{
    readonly name: string;
    readonly outside: ReadonlyArray<MatchedLine>;
  }> = [];
  for (const name of removedSymbols(input.patch)) {
    const matches = await searchSymbol(input, worktree, name, deadline);
    if (matches._tag === "unavailable") return matches;
    const outside = matches.lines.filter(
      (line) => !changedPaths.has(line.path),
    );
    if (outside.length > 0) removed.push({ name, outside });
  }

  // Removed names spend the shared site budget first: they are what breaks.
  let budget = MAX_MENTIONS_TOTAL;
  const keep = (item: {
    readonly name: string;
    readonly outside: ReadonlyArray<MatchedLine>;
  }) => {
    const kept = rankedSites(item.name, item.outside).slice(
      0,
      Math.min(MAX_MENTIONS_PER_NAME, budget),
    );
    budget -= kept.length;
    return kept;
  };
  const removedSites = removed.map(keep);
  const symbolSites = searched.map(keep);
  const fileLines = await readWorktreeFiles(worktree, [
    ...new Set(
      [...removedSites.flat(), ...symbolSites.flat()].map((site) => site.path),
    ),
  ]);
  const mentions = (sites: ReadonlyArray<RankedSite> | undefined) =>
    (sites ?? []).map((site) => mentionAt(site, fileLines.get(site.path)));

  const removedStillReferenced: Array<BriefReachRemoved> = removed.map(
    (item, index) => ({
      name: item.name,
      paths: distinctPaths(item.outside).slice(0, MAX_REACH_OUTSIDE_PATHS),
      mentions: mentions(removedSites[index]),
      mentionCount: item.outside.length,
    }),
  );
  const symbols: Array<BriefReachSymbol> = searched.map((item, index) => {
    const paths = distinctPaths(item.outside);
    return {
      name: item.name,
      outsideCallerFiles: paths.length,
      outsidePaths: paths.slice(0, MAX_REACH_OUTSIDE_PATHS),
      insidePR: item.insidePR,
      status: newNames.has(item.name) ? "new" : "changed",
      mentions: mentions(symbolSites[index]),
      mentionCount: item.outside.length,
    };
  });

  return {
    _tag: "ok",
    value: summarizeReach({ files, symbols, removedStillReferenced }),
  };
}

/** One line of the head tree that names a symbol as a whole word. */
type MatchedLine = {
  readonly path: string;
  readonly line: number;
  readonly text: string;
};

/** Every line of the head tree that names `name` as a whole word, or why the search stopped. */
type SymbolMatches =
  | { readonly _tag: "matched"; readonly lines: ReadonlyArray<MatchedLine> }
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
      "--line-number",
      "--null",
      "-e",
      name,
      input.headSha,
      "--",
      ...REACH_EXCLUDED_PATHSPECS,
    ],
    Math.min(MAX_SEARCH_MS, remaining),
  );
  if (output._tag === "empty") return { _tag: "matched", lines: [] };
  if (output._tag !== "found") return unavailable(searchFailure(output._tag));
  return { _tag: "matched", lines: matchedLines(output.stdout, input.headSha) };
}

/** A minified line can run to megabytes; the kind rules only need its start. */
const MAX_CLASSIFIED_LINE_LENGTH = 500;

/**
 * `git grep --null --line-number` prints `<rev>:<path>\0<line>\0<text>` per
 * matching line; the NULs keep a colon in a path from splitting it.
 */
function matchedLines(stdout: string, rev: string): ReadonlyArray<MatchedLine> {
  const lines: Array<MatchedLine> = [];
  for (const record of stdout.split("\n")) {
    const [location, lineNumber, ...rest] = record.split("\0");
    if (location === undefined || !location.startsWith(`${rev}:`)) continue;
    const line = Number(lineNumber);
    if (!Number.isInteger(line) || line <= 0) continue;
    lines.push({
      path: location.slice(rev.length + 1),
      line,
      text: rest.join("\0").slice(0, MAX_CLASSIFIED_LINE_LENGTH),
    });
  }
  return lines;
}

function distinctPaths(lines: ReadonlyArray<MatchedLine>): Array<string> {
  return [...new Set(lines.map((line) => line.path))];
}

/** A matched line with the kind its text reads as. */
type RankedSite = MatchedLine & { readonly kind: BriefReachMentionKind };

/** Every matched line of one name, calls first, so a cap keeps the calls. */
function rankedSites(
  name: string,
  lines: ReadonlyArray<MatchedLine>,
): ReadonlyArray<RankedSite> {
  return lines
    .map((line) => ({ ...line, kind: mentionKind(line.text, name) }))
    .sort(
      (a, b) =>
        MENTION_KIND_ORDER.indexOf(a.kind) - MENTION_KIND_ORDER.indexOf(b.kind),
    );
}

function mentionAt(
  site: RankedSite,
  lines: ReadonlyArray<string> | undefined,
): BriefReachMention {
  return {
    path: site.path,
    line: site.line,
    kind: site.kind,
    ...definedProps({
      enclosing:
        lines === undefined
          ? undefined
          : enclosingDeclaration(lines, site.line - 1),
    }),
  };
}

/**
 * Each path's lines, read once. A file that cannot be read inside the worktree
 * is left out, so it adds no enclosing names rather than failing the block.
 */
async function readWorktreeFiles(
  worktree: string,
  paths: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, ReadonlyArray<string>>> {
  const contents = await Promise.all(
    paths.map((path) => readWorktreeLines(worktree, path)),
  );
  const files = new Map<string, ReadonlyArray<string>>();
  paths.forEach((path, index) => {
    const lines = contents[index];
    if (lines !== undefined) files.set(path, lines);
  });
  return files;
}

async function readWorktreeLines(
  worktree: string,
  path: string,
): Promise<ReadonlyArray<string> | undefined> {
  try {
    const real = await realpath(join(worktree, path));
    if (!isPathContained(worktree, real)) return undefined;
    return (await readFile(real, "utf8")).split("\n");
  } catch {
    return undefined;
  }
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
