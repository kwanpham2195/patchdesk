import * as v from "valibot";

import {
  briefFlowOutputSchema,
  flowCitations,
  normalizeBriefFlow,
  type BriefFlow,
} from "./brief-flow";
import {
  briefOwnershipOutputSchema,
  normalizeBriefOwnership,
  type BriefOwnership,
} from "./brief-ownership";
import type { BriefReach, BriefReachUnavailableReason } from "./brief-reach";
import {
  briefStartHereOutputSchema,
  normalizeBriefStartHere,
  type BriefStartHere,
} from "./brief-start-here";
import { definedProps } from "./defined-props";
import type { RepoRelativePath } from "./ids";
import {
  filterNarrativePatchToHunks,
  narrativeHunkManifest,
  type NarrativeSnapshot,
} from "./narrative-walkthrough";
import { err, ok, type Result } from "./result";

/**
 * The immutable identity that binds a Brief to one stored patch: the same four
 * fields a Walkthrough is bound by, so both Insights answer "which revision is
 * this evidence from?" with one shape.
 */
export type BriefSnapshot = NarrativeSnapshot;

/** One commit of the represented pull request, reduced to what a Brief may cite. */
export type BriefCommit = {
  readonly sha: string;
  readonly subject: string;
};

/**
 * The non-patch citation sources a Brief may cite. The patch is passed
 * separately because it is an app-owned artifact read from disk, while these
 * two come from the represented GitHub snapshot.
 */
export type BriefEvidence = {
  readonly description?: string;
  readonly commits: ReadonlyArray<BriefCommit>;
};

/** Which kind of evidence one Brief alias resolves to. */
type BriefCitationKind = "hunk" | "description" | "commit";

/**
 * One resolvable alias offered to the Brief model and, once resolved, one
 * citation carried on a Brief sentence. The alias namespace is prefixed --
 * `h*` hunks, `d*` description paragraphs, `c*` commits -- so a citation names
 * its evidence kind before anything looks it up.
 */
export type BriefCitation = {
  readonly alias: string;
  readonly kind: BriefCitationKind;
  readonly label: string;
  readonly path?: RepoRelativePath;
};

/** The immutable alias-to-source manifest supplied to the Brief model. */
export type BriefManifest = ReadonlyArray<BriefCitation>;

/**
 * Where the pull request description and the diff disagree.
 *
 * `claimed` is model judgment and is labelled as such in the reader: no
 * evidence can prove that a diff does *not* do something, so each item carries
 * the description sentence it doubts and the note saying what was looked for.
 * `undescribed` is the other direction -- behavior the diff changes that the
 * description never mentions -- and each of those cites the hunks that show it.
 */
export type BriefDescriptionDrift = {
  readonly claimed: ReadonlyArray<{
    readonly quote: string;
    readonly note: string;
    readonly citations: ReadonlyArray<BriefCitation>;
  }>;
  readonly undescribed: ReadonlyArray<{
    readonly text: string;
    readonly citations: ReadonlyArray<BriefCitation>;
  }>;
};

/** A normalized, snapshot-bound Brief ready for storage and renderer projection. */
export type NormalizedBrief = {
  readonly snapshot: BriefSnapshot;
  readonly citationStatus: "verified" | "partially_verified";
  readonly goal: ReadonlyArray<{
    readonly text: string;
    readonly citations: ReadonlyArray<BriefCitation>;
  }>;
  readonly assumptions: ReadonlyArray<{
    readonly text: string;
    /** True when this line was written as Goal prose but cited nothing that resolved. */
    readonly demoted: boolean;
  }>;
  /** Absent when the pull request has no description to compare the diff against. */
  readonly descriptionDrift?: BriefDescriptionDrift;
  /**
   * Absent only on a Brief retained before the Ownership block existed:
   * `normalizeBrief` always produces one, because its skeleton is computed from
   * the patch rather than asked of the model.
   */
  readonly ownership?: BriefOwnership;
  /**
   * Where to start reading. Absent on a Brief retained before the block
   * existed, and whenever no path the model proposed is a file this patch
   * changed.
   */
  readonly startHere?: BriefStartHere;
  /**
   * The counted Reach block. `normalizeBrief` never produces one: counting
   * needs a `git grep` over the represented worktree, so the completion path
   * attaches it afterwards (`computeBriefReach`).
   */
  readonly reach?: BriefReach;
  /** Why there is no `reach`; present only when the search was attempted and could not answer. */
  readonly reachUnavailable?: BriefReachUnavailableReason;
  /**
   * The one-hunk unified patch text for every `h*` alias this Brief cites,
   * keyed by alias, so a citation chip can show the hunk in a popover. Cut
   * from the session patch by Patchdesk, never text the model wrote. Absent
   * on a Brief retained before this existed, and whenever no cited hunk
   * could be cut.
   */
  readonly citedHunks?: Readonly<Record<string, string>>;
  /**
   * The Flow block: up to two before/after trees of a runtime sequence.
   * Absent on a Brief retained before the block existed, and whenever no
   * tree survived normalization.
   */
  readonly flow?: BriefFlow;
};

/** Reasons a Brief result is rejected before it can be retained. */
export type BriefError = {
  readonly _tag: "InvalidBrief";
  readonly reason: "malformed" | "uncited";
};

const MAX_GOAL_ITEMS = 8;
const MAX_GOAL_TEXT_LENGTH = 400;
const MAX_ASSUMPTIONS = 12;
const MAX_ASSUMPTION_LENGTH = 400;
const MAX_CITATIONS_PER_ITEM = 8;
const MAX_DRIFT_ITEMS = 6;
const MAX_DRIFT_TEXT_LENGTH = 400;
const MAX_ALIAS_LENGTH = 16;
const MAX_REACH_SYMBOLS = 24;
const MAX_REACH_SYMBOL_LENGTH = 200;
const MAX_DESCRIPTION_PARAGRAPHS = 40;
const MAX_COMMIT_CITATIONS = 100;
const MAX_LABEL_LENGTH = 200;
/** `h*` hunks, `d*` description paragraphs, `c*` commits; anything else is not an alias. */
export const BRIEF_ALIAS_SYNTAX = /^[hdc][1-9]\d*$/;
/** A hunk larger than this is not something a popover can show; the chip then has no preview. */
export const MAX_CITED_HUNK_RAW_LENGTH = 16_000;
/**
 * The whole `citedHunks` map stays under this many characters, no matter how
 * many hunks a Brief cites: the workbench projection response the desktop
 * bridge returns is capped at 8 MB (`maxResponseBytes` in
 * `src/main/desktop-bridge.ts`), and a Brief can cite up to ~160 hunks, each
 * as large as `MAX_CITED_HUNK_RAW_LENGTH` -- unchecked, that alone could
 * approach the cap and fail the projection the Review needs to open.
 */
export const MAX_CITED_HUNKS_TOTAL_LENGTH = 256_000;

const citationAliasesSchema = v.pipe(
  v.array(v.pipe(v.string(), v.maxLength(MAX_ALIAS_LENGTH))),
  v.maxLength(MAX_CITATIONS_PER_ITEM),
);

const driftTextSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(MAX_DRIFT_TEXT_LENGTH),
);

/**
 * Raw structured output accepted from a Brief child before Patchdesk resolves
 * its citations. `reachSymbols` is parsed and carried no further here: the
 * Reach block filters the names against the patch (`candidateReachSymbols`) and
 * counts them with `git grep`, so the model never writes the number.
 * `descriptionDrift` is optional because a pull request with no description has
 * nothing to compare the diff against.
 */
export const briefOutputSchema = v.strictObject({
  goal: v.pipe(
    v.array(
      v.strictObject({
        text: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(MAX_GOAL_TEXT_LENGTH),
        ),
        citations: citationAliasesSchema,
      }),
    ),
    v.maxLength(MAX_GOAL_ITEMS),
  ),
  descriptionDrift: v.optional(
    v.strictObject({
      claimed: v.pipe(
        v.array(
          v.strictObject({
            quote: driftTextSchema,
            citations: citationAliasesSchema,
            note: driftTextSchema,
          }),
        ),
        v.maxLength(MAX_DRIFT_ITEMS),
      ),
      undescribed: v.pipe(
        v.array(
          v.strictObject({
            text: driftTextSchema,
            citations: citationAliasesSchema,
          }),
        ),
        v.maxLength(MAX_DRIFT_ITEMS),
      ),
    }),
  ),
  ownership: briefOwnershipOutputSchema,
  startHere: briefStartHereOutputSchema,
  flow: briefFlowOutputSchema,
  assumptions: v.pipe(
    v.array(
      v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ASSUMPTION_LENGTH)),
    ),
    v.maxLength(MAX_ASSUMPTIONS),
  ),
  reachSymbols: v.optional(
    v.pipe(
      v.array(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(MAX_REACH_SYMBOL_LENGTH),
        ),
      ),
      v.maxLength(MAX_REACH_SYMBOLS),
    ),
  ),
});

/**
 * The JSON contract every Brief child is given, stated once for both providers.
 *
 * `descriptionDrift.claimed` holds behavior claims only -- what the code does,
 * or no longer does. A description line about a build, a test run, a benchmark,
 * lint, CI, a screenshot, or a manual check is not drift, because a patch can
 * never carry a verification result; `insightOutputGuidance("brief")` states
 * that rule to the model in the same prompt as this shape.
 *
 * `flow` is optional, like `ownership` and `startHere`: a Brief with no flow
 * proposed is still a complete Brief. Every `added`/`removed` node must keep
 * at least one citation that resolves to a hunk -- a description or commit
 * alias is never evidence that a runtime step changed, no matter how it is
 * paired with a real one.
 */
export const BRIEF_RESULT_CONTRACT =
  '{"goal":[{"text":string,"citations":[string]}],"descriptionDrift":{"claimed":[{"quote":string,"citations":[string],"note":string}],"undescribed":[{"text":string,"citations":[string]}]},"ownership":{"notes":[{"path":string,"note":string}],"contract":{"citation":string,"caption":string}},"startHere":{"lead":string,"order":[{"path":string,"why":string}]},"flow":[{"title":string,"nodes":[{"label":string,"change":"added"|"removed"|"unchanged","citations":[string],"children":[...]}]}],"assumptions":[string],"reachSymbols":[string]}';

export type BriefOutput = v.InferOutput<typeof briefOutputSchema>;
export type InvalidBriefOutput = { readonly _tag: "InvalidBriefOutput" };

/** Parses one Brief child's structured reply at the child I/O boundary. */
export function parseBriefOutput(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the Brief output's own I/O boundary; the very next statement runs `safeParse(briefOutputSchema, input)` against it before anything else touches it.
  input: unknown,
): Result<BriefOutput, InvalidBriefOutput> {
  const parsed = v.safeParse(briefOutputSchema, input);
  return parsed.success
    ? ok(parsed.output)
    : err({ _tag: "InvalidBriefOutput" });
}

/**
 * Builds the alias manifest for one Brief run.
 *
 * An unindexable patch yields no `h*` aliases rather than failing the whole
 * manifest: a Brief that cites only the description or a commit is still a
 * cited Brief, and `normalizeBrief` is the one place that decides whether the
 * surviving citations are enough.
 */
export function briefManifest(input: {
  readonly patch: string;
  readonly description?: string;
  readonly commits: ReadonlyArray<BriefCommit>;
}): BriefManifest {
  const entries: Array<BriefCitation> = [];
  const hunks = narrativeHunkManifest(input.patch);
  if (hunks._tag === "ok")
    for (const hunk of hunks.value)
      entries.push({
        alias: hunk.id,
        kind: "hunk",
        label: singleLine(hunk.header),
        path: hunk.path,
      });
  for (const [index, paragraph] of descriptionParagraphs(
    input.description,
  ).entries())
    entries.push({
      alias: `d${index + 1}`,
      kind: "description",
      label: paragraph,
    });
  for (const [index, commit] of input.commits
    .slice(0, MAX_COMMIT_CITATIONS)
    .entries())
    entries.push({
      alias: `c${index + 1}`,
      kind: "commit",
      label: singleLine(`${commit.sha.slice(0, 7)} ${commit.subject}`),
    });
  return entries;
}

/** Renders the manifest as the `alias | kind | label` lines a prompt carries. */
export function renderBriefManifest(manifest: BriefManifest): string {
  return manifest
    .map((entry) => `${entry.alias} | ${entry.kind} | ${entry.label}`)
    .join("\n");
}

/**
 * Normalizes untrusted Brief output against one manifest.
 *
 * A Goal sentence keeps only the citations whose alias resolves. A sentence
 * left with none is demoted to an Assumption instead of being deleted -- the
 * Brief may state something it cannot cite, but never as a Goal -- and a Brief
 * whose every sentence is demoted is rejected outright.
 *
 * Description drift follows the same rule with a kind requirement: a claimed
 * item must cite a `d*` alias, because it quotes description text, and an
 * undescribed item must cite an `h*` alias, because it names what the diff
 * does. An item that cites neither is dropped, exactly like a rejected Goal
 * citation, and never fails the run.
 *
 * The patch is passed beside the manifest because the Ownership block's skeleton
 * and its one contract hunk are cut from the patch itself, never asked of the
 * model.
 */
export function normalizeBrief(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the Brief result's normalization boundary; the very next statement runs `safeParse(briefOutputSchema, raw)` against it before anything else touches it.
  raw: unknown,
  manifest: BriefManifest,
  patch: string,
  snapshot: BriefSnapshot,
): Result<NormalizedBrief, BriefError> {
  const parsed = v.safeParse(briefOutputSchema, raw);
  if (!parsed.success) return invalidBrief("malformed");
  const byAlias = new Map(manifest.map((entry) => [entry.alias, entry]));
  const goal: Array<NormalizedBrief["goal"][number]> = [];
  const demoted: Array<string> = [];
  let rejectedCitationCount = 0;

  for (const item of parsed.output.goal) {
    const resolved = resolveBriefCitations(item.citations, byAlias);
    rejectedCitationCount += resolved.rejected;
    const text = item.text.trim();
    if (resolved.citations.length === 0) {
      demoted.push(text);
      continue;
    }
    goal.push({ text, citations: resolved.citations });
  }
  if (goal.length === 0) return invalidBrief("uncited");

  const drift = normalizeDescriptionDrift(
    parsed.output.descriptionDrift,
    manifest,
    byAlias,
  );
  rejectedCitationCount += drift.rejected;

  const ownership = normalizeBriefOwnership(parsed.output.ownership, patch);
  rejectedCitationCount += ownership.rejected;

  // The Ownership skeleton is already the patch's changed, non-generated file
  // list, so the reading order is checked against it rather than re-walking
  // the patch.
  const startHere = normalizeBriefStartHere(
    parsed.output.startHere,
    ownership.value.files,
  );
  rejectedCitationCount += startHere.rejected;

  const flow = normalizeBriefFlow(parsed.output.flow, byAlias);
  rejectedCitationCount += flow.rejected;

  const citedHunks = cutCitedHunks(
    [
      ...goal.flatMap((item) => item.citations),
      ...(drift.value?.claimed.flatMap((item) => item.citations) ?? []),
      ...(drift.value?.undescribed.flatMap((item) => item.citations) ?? []),
      ...flowCitations(flow.value),
    ],
    patch,
  );

  return ok({
    snapshot,
    citationStatus:
      rejectedCitationCount === 0 && demoted.length === 0
        ? "verified"
        : "partially_verified",
    goal,
    assumptions: [
      ...parsed.output.assumptions.map((text) => ({
        text: text.trim(),
        demoted: false,
      })),
      ...demoted.map((text) => ({ text, demoted: true })),
    ],
    ...definedProps({
      descriptionDrift: drift.value,
      startHere: startHere.value,
      flow: flow.value,
      citedHunks: Object.keys(citedHunks).length > 0 ? citedHunks : undefined,
    }),
    ownership: ownership.value,
  });
}

/** The aliases one item resolved to, and how many of them named nothing. */
type ResolvedBriefCitations = {
  readonly citations: ReadonlyArray<BriefCitation>;
  readonly rejected: number;
};

/** The drift block that survived normalization, and what it cost in citations. */
type NormalizedDescriptionDrift = {
  readonly value: BriefDescriptionDrift | undefined;
  readonly rejected: number;
};

/**
 * Resolves a list of citation aliases against one manifest, dropping an
 * alias that names nothing and a repeat of one already used. Exported so
 * `normalizeBriefFlow` (`brief-flow.ts`) can apply the same alias-resolution
 * rule before narrowing further to hunk-only citations.
 */
export function resolveBriefCitations(
  aliases: ReadonlyArray<string>,
  byAlias: ReadonlyMap<string, BriefCitation>,
): ResolvedBriefCitations {
  const citations: Array<BriefCitation> = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const alias of aliases) {
    const entry = BRIEF_ALIAS_SYNTAX.test(alias)
      ? byAlias.get(alias)
      : undefined;
    if (entry === undefined || seen.has(alias)) {
      rejected += 1;
      continue;
    }
    seen.add(alias);
    citations.push(entry);
  }
  return { citations, rejected };
}

/**
 * Keeps only the drift items whose citations resolve to the evidence kind the
 * item is about. A pull request with no description has no `d*` alias to quote,
 * so the whole block is omitted rather than half-shown or rejected.
 */
function normalizeDescriptionDrift(
  drift: BriefOutput["descriptionDrift"],
  manifest: BriefManifest,
  byAlias: ReadonlyMap<string, BriefCitation>,
): NormalizedDescriptionDrift {
  const hasDescription = manifest.some((entry) => entry.kind === "description");
  if (drift === undefined || !hasDescription)
    return { value: undefined, rejected: 0 };
  let rejected = 0;
  const claimed: Array<BriefDescriptionDrift["claimed"][number]> = [];
  for (const item of drift.claimed) {
    const resolved = resolveBriefCitations(item.citations, byAlias);
    rejected += resolved.rejected;
    if (!resolved.citations.some((entry) => entry.kind === "description")) {
      rejected += 1;
      continue;
    }
    claimed.push({
      quote: item.quote.trim(),
      note: item.note.trim(),
      citations: resolved.citations,
    });
  }
  const undescribed: Array<BriefDescriptionDrift["undescribed"][number]> = [];
  for (const item of drift.undescribed) {
    const resolved = resolveBriefCitations(item.citations, byAlias);
    rejected += resolved.rejected;
    if (!resolved.citations.some((entry) => entry.kind === "hunk")) {
      rejected += 1;
      continue;
    }
    undescribed.push({ text: item.text.trim(), citations: resolved.citations });
  }
  return { value: { claimed, undescribed }, rejected };
}

/**
 * Cuts the one-hunk unified patch text for every `h*` alias among the given
 * citations, keyed by alias. A hunk `filterNarrativePatchToHunks` cannot cut,
 * or one whose raw text runs past `MAX_CITED_HUNK_RAW_LENGTH`, is left out of
 * the map instead of failing the Brief -- the chip then just has no preview.
 * The ownership contract hunk is never in `citations` here: it already
 * carries its own `raw` and is not part of `goal` or `descriptionDrift`.
 *
 * Aliases are cut in manifest order (`h1`, `h2`, ...) rather than citation
 * order, so which hunks survive is deterministic. Once the running total would
 * cross `MAX_CITED_HUNKS_TOTAL_LENGTH`, cutting stops -- a Brief that cites
 * many large hunks gets the leading ones rather than none, and the map never
 * grows large enough to threaten the projection response budget.
 */
function cutCitedHunks(citations: ReadonlyArray<BriefCitation>, patch: string) {
  const aliases = new Set<string>();
  for (const citation of citations)
    if (citation.kind === "hunk") aliases.add(citation.alias);
  const ordered = [...aliases].sort(
    (left, right) => hunkAliasIndex(left) - hunkAliasIndex(right),
  );
  const citedHunks: Record<string, string> = {};
  let totalLength = 0;
  for (const alias of ordered) {
    const raw = filterNarrativePatchToHunks(patch, [alias]);
    if (raw.length === 0 || raw.length > MAX_CITED_HUNK_RAW_LENGTH) continue;
    if (totalLength + raw.length > MAX_CITED_HUNKS_TOTAL_LENGTH) break;
    citedHunks[alias] = raw;
    totalLength += raw.length;
  }
  return citedHunks;
}

/** The number after the `h` in a hunk alias, so cited hunks sort into manifest order. */
function hunkAliasIndex(alias: string): number {
  return Number(alias.slice(1));
}

function invalidBrief(reason: BriefError["reason"]): Result<never, BriefError> {
  return err({ _tag: "InvalidBrief", reason });
}

/** Splits a pull request body into the paragraphs a `d*` alias names. */
function descriptionParagraphs(
  description: string | undefined,
): ReadonlyArray<string> {
  if (description === undefined) return [];
  return description
    .split(/\n[ \t]*\n/)
    .map((paragraph) => singleLine(paragraph))
    .filter((paragraph) => paragraph.length > 0)
    .slice(0, MAX_DESCRIPTION_PARAGRAPHS);
}

/** One manifest line per alias, so a label may never carry its own newline. */
function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
}
