import * as v from "valibot";

import {
  BRIEF_ALIAS_SYNTAX,
  type BriefCitation,
  type BriefManifest,
} from "./brief-citation";
import { resolveBriefCitations } from "./brief-citation-resolution";
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

/**
 * `BriefCitation`, `BriefManifest`, and `BRIEF_ALIAS_SYNTAX` live in
 * `brief-citation.ts` -- a leaf module `brief-flow.ts` can import from
 * directly, which is what keeps this file and `brief-flow.ts` from forming
 * an import cycle. Re-exported here so an existing importer of them from
 * `./brief` needs no change.
 */
export { BRIEF_ALIAS_SYNTAX, type BriefCitation, type BriefManifest };

/**
 * `resolveBriefCitations` lives in `brief-citation-resolution.ts` for the
 * same cycle-breaking reason. Re-exported here so an existing importer of it
 * from `./brief` needs no change.
 */
export { resolveBriefCitations };

/**
 * A normalized, snapshot-bound Brief ready for storage and renderer
 * projection. Brief is structure-first (ADR 0040): Ownership, Start here,
 * Flow, and Reach, plus the Scope gauge computed elsewhere. There is no
 * prose block left to grade a citation against, so `citationStatus` is the
 * whole verification story -- see its own doc comment below.
 */
export type NormalizedBrief = {
  readonly snapshot: BriefSnapshot;
  /**
   * `"verified"` when normalization discarded no citation anywhere in the
   * Brief; `"partially_verified"` otherwise. Re-anchored on Flow (ADR 0040):
   * an `added`/`removed` step with no surviving hunk citation is kept and
   * marked, not dropped, so there is nothing left to grade a value below
   * these two.
   */
  readonly citationStatus: "verified" | "partially_verified";
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
   * The Flow block: up to `MAX_FLOW_TREES` before/after trees of a runtime
   * sequence, at most one per kind. Absent on a Brief retained before the
   * block existed, and whenever no tree survived normalization.
   */
  readonly flow?: BriefFlow;
};

/**
 * Reasons a Brief result is rejected before it can be retained. `uncited` is
 * gone (ADR 0040): Flow keeps an uncited step, muted, rather than rejecting
 * the whole Brief for it, so a Brief with no Flow at all -- a rename, a docs
 * change, a pure refactor -- is still a complete, valid Brief. Only
 * malformed output is rejected now.
 */
export type BriefError = {
  readonly _tag: "InvalidBrief";
  readonly reason: "malformed";
};

const MAX_REACH_SYMBOLS = 24;
const MAX_REACH_SYMBOL_LENGTH = 200;
const MAX_LABEL_LENGTH = 200;
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

/**
 * Raw structured output accepted from a Brief child before Patchdesk resolves
 * its citations. `reachSymbols` is parsed and carried no further here: the
 * Reach block filters the names against the patch (`candidateReachSymbols`) and
 * counts them with `git grep`, so the model never writes the number.
 *
 * Brief is structure-first (ADR 0040): there is no Goal, Assumptions, or
 * description-vs-diff key left to accept. `ownership`, `startHere`, and
 * `flow` are each optional -- a Brief that proposes none of them is still
 * complete, unconditionally combined rather than gated on a surviving Goal.
 */
export const briefOutputSchema = v.strictObject({
  ownership: briefOwnershipOutputSchema,
  startHere: briefStartHereOutputSchema,
  flow: briefFlowOutputSchema,
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
 * The JSON contract every Brief child is given, stated once for both
 * providers. Brief is structure-first (ADR 0040): four blocks, no prose.
 *
 * `ownership` is Patchdesk's own skeleton with the model's per-file notes.
 * `startHere` is the reading order. `flow` is optional, like `ownership` and
 * `startHere`: a Brief with no flow proposed is still a complete Brief.
 * Every tree carries a `kind`: `call_tree` is real function or method names
 * with parameter names as written in the patch, `control_flow` is short
 * pseudocode lines, and `component` is a `<ComponentName>` tree. Every
 * `added`/`removed` node should cite a hunk when the patch shows it -- a
 * description or commit alias is never evidence that a runtime step
 * changed, no matter how it is paired with a real one; an uncited step is
 * kept and marked, not dropped. `reachSymbols` names the candidates for the
 * counted Reach block; the model never writes the count itself.
 */
export const BRIEF_RESULT_CONTRACT =
  '{"ownership":{"notes":[{"path":string,"note":string}]},"startHere":{"lead":string,"order":[{"path":string,"why":string}]},"flow":[{"kind":"call_tree"|"control_flow"|"component","title":string,"nodes":[{"label":string,"change":"added"|"removed"|"unchanged","citations":[string],"children":[...]}]}],"reachSymbols":[string]}';

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
 * Builds the alias manifest for one Brief run: `h*` hunks only.
 *
 * ADR 0040 retired the two prose blocks that could cite a `d*` description
 * paragraph or a `c*` commit -- Flow, the one surviving block that cites
 * anything, cites hunks only -- so nothing offers those aliases anymore.
 * `BriefCitationKind` and `BRIEF_ALIAS_SYNTAX` still carry `description` and
 * `commit` because a stored Brief from 0.1.3 may still hold citations of
 * those kinds; this manifest simply never builds one.
 *
 * An unindexable patch yields no `h*` aliases rather than failing the whole
 * manifest: a Brief that proposes no Flow at all is still a complete Brief.
 */
export function briefManifest(input: {
  readonly patch: string;
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
 * There is no prose block left to grade a citation against (ADR 0040): Flow
 * already applies its own rule while it walks each proposed tree (see
 * `normalizeBriefFlow` in `brief-flow.ts`) -- an `added`/`removed` step with
 * no surviving hunk citation is kept and marked, never dropped or demoted to
 * a lower-confidence block. Ownership and Start here take no citations at
 * all. An uncited claim is kept, muted, and counted toward `rejected`; this
 * function never rejects a Brief for lacking one, so a Brief with no Flow at
 * all -- a rename, a docs change, a pure refactor -- is still a complete,
 * valid Brief with Ownership, Start here, and Reach.
 *
 * The patch is passed beside the manifest because the Ownership block's
 * skeleton is cut from the patch itself, never asked of the model.
 */
export function normalizeBrief(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the Brief result's normalization boundary; the very next statement runs `safeParse(briefOutputSchema, raw)` against it before anything else touches it.
  raw: unknown,
  manifest: BriefManifest,
  patch: string,
  snapshot: BriefSnapshot,
): Result<NormalizedBrief, BriefError> {
  const parsed = v.safeParse(briefOutputSchema, raw);
  if (!parsed.success) return invalidBrief();
  const byAlias = new Map(manifest.map((entry) => [entry.alias, entry]));
  let rejectedCitationCount = 0;

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

  const flow = normalizeBriefFlow(
    parsed.output.flow,
    byAlias,
    ownership.value.files.map((file) => file.path),
  );
  rejectedCitationCount += flow.rejected;

  const citedHunks = cutCitedHunks(flowCitations(flow.value), patch);

  return ok({
    snapshot,
    citationStatus:
      rejectedCitationCount === 0 ? "verified" : "partially_verified",
    ownership: ownership.value,
    ...definedProps({
      startHere: startHere.value,
      flow: flow.value,
      citedHunks: Object.keys(citedHunks).length > 0 ? citedHunks : undefined,
    }),
  });
}

/**
 * Cuts the one-hunk unified patch text for every `h*` alias among the given
 * citations, keyed by alias. A hunk `filterNarrativePatchToHunks` cannot cut,
 * or one whose raw text runs past `MAX_CITED_HUNK_RAW_LENGTH`, is left out of
 * the map instead of failing the Brief -- the chip then just has no preview.
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

/** The one rejection left: output that failed to parse as `briefOutputSchema`. */
function invalidBrief(): Result<never, BriefError> {
  return err({ _tag: "InvalidBrief", reason: "malformed" });
}

/** One manifest line per alias, so a label may never carry its own newline. */
function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
}
