import * as v from "valibot";

import { definedProps } from "./defined-props";
import {
  parseContentHash,
  parseGitSha,
  parseRepoRelativePath,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type RepoRelativePath,
} from "./ids";
import {
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
type BriefCitation = {
  readonly alias: string;
  readonly kind: BriefCitationKind;
  readonly label: string;
  readonly path?: RepoRelativePath;
};

/** The immutable alias-to-source manifest supplied to the Brief model. */
export type BriefManifest = ReadonlyArray<BriefCitation>;

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
const MAX_ALIAS_LENGTH = 16;
const MAX_REACH_SYMBOLS = 24;
const MAX_REACH_SYMBOL_LENGTH = 200;
const MAX_DESCRIPTION_PARAGRAPHS = 40;
const MAX_COMMIT_CITATIONS = 100;
const MAX_LABEL_LENGTH = 200;
/** `h*` hunks, `d*` description paragraphs, `c*` commits; anything else is not an alias. */
const BRIEF_ALIAS_SYNTAX = /^[hdc][1-9]\d*$/;

/**
 * Raw structured output accepted from a Brief child before Patchdesk resolves
 * its citations. `reachSymbols` is parsed and carried no further here: the
 * Reach block counts them with a tool in a later slice, and the model never
 * writes the number.
 */
const briefOutputSchema = v.strictObject({
  goal: v.pipe(
    v.array(
      v.strictObject({
        text: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(MAX_GOAL_TEXT_LENGTH),
        ),
        citations: v.pipe(
          v.array(v.pipe(v.string(), v.maxLength(MAX_ALIAS_LENGTH))),
          v.maxLength(MAX_CITATIONS_PER_ITEM),
        ),
      }),
    ),
    v.maxLength(MAX_GOAL_ITEMS),
  ),
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

/** The JSON contract every Brief child is given, stated once for both providers. */
export const BRIEF_RESULT_CONTRACT =
  '{"goal":[{"text":string,"citations":[string]}],"assumptions":[string],"reachSymbols":[string]}';

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
 */
export function normalizeBrief(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the Brief result's normalization boundary; the very next statement runs `safeParse(briefOutputSchema, raw)` against it before anything else touches it.
  raw: unknown,
  manifest: BriefManifest,
  snapshot: BriefSnapshot,
): Result<NormalizedBrief, BriefError> {
  const parsed = v.safeParse(briefOutputSchema, raw);
  if (!parsed.success) return invalidBrief("malformed");
  const byAlias = new Map(manifest.map((entry) => [entry.alias, entry]));
  const goal: Array<NormalizedBrief["goal"][number]> = [];
  const demoted: Array<string> = [];
  let rejectedCitationCount = 0;

  for (const item of parsed.output.goal) {
    const citations: Array<BriefCitation> = [];
    const seen = new Set<string>();
    for (const alias of item.citations) {
      const entry = BRIEF_ALIAS_SYNTAX.test(alias)
        ? byAlias.get(alias)
        : undefined;
      if (entry === undefined || seen.has(alias)) {
        rejectedCitationCount += 1;
        continue;
      }
      seen.add(alias);
      citations.push(entry);
    }
    const text = item.text.trim();
    if (citations.length === 0) {
      demoted.push(text);
      continue;
    }
    goal.push({ text, citations });
  }
  if (goal.length === 0) return invalidBrief("uncited");

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
  });
}

const storedCitationSchema = v.strictObject({
  alias: v.pipe(v.string(), v.regex(BRIEF_ALIAS_SYNTAX)),
  kind: v.picklist(["hunk", "description", "commit"]),
  label: v.string(),
  path: v.optional(v.string()),
});
const storedBriefSchema = v.strictObject({
  snapshot: v.strictObject({
    profileId: v.string(),
    sessionId: v.string(),
    headSha: v.string(),
    patchHash: v.string(),
  }),
  citationStatus: v.picklist(["verified", "partially_verified"]),
  goal: v.pipe(
    v.array(
      v.strictObject({
        text: v.pipe(v.string(), v.minLength(1)),
        citations: v.pipe(v.array(storedCitationSchema), v.minLength(1)),
      }),
    ),
    v.minLength(1),
  ),
  assumptions: v.array(
    v.strictObject({ text: v.string(), demoted: v.boolean() }),
  ),
});

/**
 * Parses one Brief that storage already holds. A retained Brief carries its own
 * resolved citation labels, so reading it back needs no patch bytes -- unlike a
 * Walkthrough, which must be renormalized against its session's patch.
 */
export function parseStoredBrief(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the stored Brief's read boundary; the very next statement runs `safeParse(storedBriefSchema, input)` against it before anything else touches it.
  input: unknown,
): Result<NormalizedBrief, BriefError> {
  const parsed = v.safeParse(storedBriefSchema, input);
  if (!parsed.success) return invalidBrief("malformed");
  const profileId = parseWorkspaceProfileId(parsed.output.snapshot.profileId);
  const sessionId = parseReviewSessionId(parsed.output.snapshot.sessionId);
  const headSha = parseGitSha(parsed.output.snapshot.headSha);
  const patchHash = parseContentHash(parsed.output.snapshot.patchHash);
  if (
    profileId._tag === "err" ||
    sessionId._tag === "err" ||
    headSha._tag === "err" ||
    patchHash._tag === "err"
  )
    return invalidBrief("malformed");
  const goal: Array<NormalizedBrief["goal"][number]> = [];
  for (const item of parsed.output.goal) {
    const citations: Array<BriefCitation> = [];
    for (const citation of item.citations) {
      const path =
        citation.path === undefined
          ? undefined
          : parseRepoRelativePath(citation.path);
      if (path?._tag === "err") return invalidBrief("malformed");
      citations.push({
        alias: citation.alias,
        kind: citation.kind,
        label: citation.label,
        ...definedProps({ path: path?.value }),
      });
    }
    goal.push({ text: item.text, citations });
  }
  return ok({
    snapshot: {
      profileId: profileId.value,
      sessionId: sessionId.value,
      headSha: headSha.value,
      patchHash: patchHash.value,
    },
    citationStatus: parsed.output.citationStatus,
    goal,
    assumptions: parsed.output.assumptions,
  });
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
