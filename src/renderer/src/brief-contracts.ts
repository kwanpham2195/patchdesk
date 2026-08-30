import * as v from "valibot";

import { definedProps } from "../../domain/defined-props";
import { insightFields, retainedInsightFields } from "./insight-contracts";

/**
 * The renderer's view of one retained Brief.
 *
 * It mirrors `storedBriefSchema` in `src/domain/brief.ts`: a Brief is retained
 * with its citation labels already resolved, so the renderer reads labels, not
 * patch coordinates. A citation `path` is display text here (the chip's file
 * name); the main process is where it passed `parseRepoRelativePath`, and
 * nothing in the reader resolves it against the diff.
 */
const briefCitationSchema = v.strictObject({
  alias: v.pipe(v.string(), v.minLength(1), v.maxLength(16)),
  kind: v.picklist(["hunk", "description", "commit"]),
  label: v.pipe(v.string(), v.maxLength(200)),
  path: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(1_024))),
});

/**
 * The Ownership block. `files` is Patchdesk's own skeleton of the patch, so the
 * renderer draws it as given; `notes` and `contract.caption` are the only
 * model-written text here, and `contract.raw` was cut from the session patch by
 * the main process.
 */
const briefOwnershipSchema = v.strictObject({
  files: v.array(
    v.strictObject({
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
      status: v.picklist(["added", "removed", "modified", "renamed"]),
      additions: v.pipe(v.number(), v.integer(), v.minValue(0)),
      deletions: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
  ),
  notes: v.array(
    v.strictObject({
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
      note: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    }),
  ),
  contract: v.optional(
    v.strictObject({
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
      header: v.pipe(v.string(), v.maxLength(400)),
      raw: v.pipe(v.string(), v.minLength(1)),
      caption: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    }),
  ),
});

/**
 * The Start here block. The main process already cut this order down to files
 * the patch changes, so the reader draws it as given; the numbering is honest
 * here because the order is the information.
 */
const briefStartHereSchema = v.strictObject({
  lead: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  order: v.array(
    v.strictObject({
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
      why: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
    }),
  ),
});

/**
 * The Reach block. Every number here was produced by a `git grep` in the main
 * process, never by the model, and `method`/`hop` travel with the counts so the
 * reader's footer can state how they were made.
 */
const briefReachSchema = v.strictObject({
  symbols: v.array(
    v.strictObject({
      name: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
      outsideCallerFiles: v.pipe(v.number(), v.integer(), v.minValue(0)),
      outsidePaths: v.array(
        v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
      ),
      insidePR: v.boolean(),
    }),
  ),
  surfaces: v.array(
    v.strictObject({
      surface: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
      path: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(1_024))),
    }),
  ),
  untested: v.array(
    v.strictObject({
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(1_024)),
      reason: v.literal("no_test_in_pr"),
    }),
  ),
  removedStillReferenced: v.array(
    v.strictObject({
      name: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
      paths: v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_024))),
    }),
  ),
  method: v.literal("text_match"),
  hop: v.literal(1),
});

const briefSchema = v.strictObject({
  snapshot: v.strictObject({
    profileId: v.pipe(v.string(), v.minLength(1)),
    sessionId: v.pipe(v.string(), v.minLength(1)),
    headSha: v.pipe(v.string(), v.minLength(7)),
    patchHash: v.pipe(v.string(), v.minLength(1)),
  }),
  citationStatus: v.picklist(["verified", "partially_verified"]),
  goal: v.array(
    v.strictObject({
      text: v.pipe(v.string(), v.minLength(1)),
      citations: v.array(briefCitationSchema),
    }),
  ),
  assumptions: v.array(
    v.strictObject({ text: v.string(), demoted: v.boolean() }),
  ),
  /** Absent when the pull request carried no description to compare the diff against. */
  descriptionDrift: v.optional(
    v.strictObject({
      claimed: v.array(
        v.strictObject({
          quote: v.pipe(v.string(), v.minLength(1)),
          note: v.string(),
          citations: v.array(briefCitationSchema),
        }),
      ),
      undescribed: v.array(
        v.strictObject({
          text: v.pipe(v.string(), v.minLength(1)),
          citations: v.array(briefCitationSchema),
        }),
      ),
    }),
  ),
  /** Absent on a Brief retained before the Ownership block existed. */
  ownership: v.optional(briefOwnershipSchema),
  /** Absent on a Brief retained before the Start here block existed, and whenever no proposed path was a changed file. */
  startHere: v.optional(briefStartHereSchema),
  /** Absent on a Brief retained before the Reach block existed, and whenever the search could not answer. */
  reach: v.optional(briefReachSchema),
  reachUnavailable: v.optional(
    v.picklist([
      "worktree_unavailable",
      "head_mismatch",
      "search_failed",
      "timed_out",
    ]),
  ),
});

/** The Brief's own Insight projection: the shared run envelope around one Brief. */
export const briefInsightSchema = v.strictObject({
  ...insightFields,
  retained: v.optional(
    v.strictObject({ ...retainedInsightFields, value: briefSchema }),
  ),
});

export type BriefInsight = v.InferOutput<typeof briefInsightSchema>;
export type Brief = v.InferOutput<typeof briefSchema>;
export type BriefCitation = v.InferOutput<typeof briefCitationSchema>;
export type BriefOwnership = v.InferOutput<typeof briefOwnershipSchema>;
export type BriefOwnershipContract = NonNullable<BriefOwnership["contract"]>;
export type BriefReach = v.InferOutput<typeof briefReachSchema>;
export type BriefStartHere = v.InferOutput<typeof briefStartHereSchema>;

/** What the Reach footer says the counts are, so no reader mistakes them for a call graph. */
export function briefReachMethodLine(
  reach: BriefReach,
  headSha: string,
): string {
  const method = reach.method === "text_match" ? "Text search" : reach.method;
  return `${method} over the represented worktree at ${headSha.slice(0, 7)}, ${reach.hop === 1 ? "one hop" : `${String(reach.hop)} hops`} out from the diff. A name match is not a call graph; treat counts as places to look.`;
}

/** One named thing a Reach row lists, with the count Patchdesk made for it. */
type BriefReachItem = {
  readonly name: string;
  /** Already written out, because the count and its unit belong in one phrase. */
  readonly count: string;
  /** True when something outside this pull request is reached; drawn in the warning hue. */
  readonly hot: boolean;
  readonly paths: ReadonlyArray<string>;
};

/** One list row of the Reach block, including what to say when it lists nothing. */
export type BriefReachRow = {
  readonly label: string;
  readonly hint?: string;
  readonly items: ReadonlyArray<BriefReachItem>;
  readonly empty: string;
};

/** The Reach block's three list rows; the fourth row draws surface chips instead. */
export type BriefReachRows = {
  readonly contracts: BriefReachRow;
  readonly untested: BriefReachRow;
  readonly removed: BriefReachRow;
};

const files = (count: number) =>
  `${String(count)} ${count === 1 ? "file" : "files"}`;

/**
 * Turns the counted block into the rows the reader draws. Every number here was
 * produced by the main process; this only chooses the words around it.
 */
export function briefReachRows(reach: BriefReach): BriefReachRows {
  return {
    contracts: {
      label: "Changed contracts",
      hint: "callers outside this PR",
      empty: "No changed contract to count.",
      items: reach.symbols.map((symbol) => ({
        name: symbol.name,
        count:
          symbol.outsideCallerFiles === 0 && symbol.insidePR
            ? "0 files outside this PR · named only inside it"
            : `${files(symbol.outsideCallerFiles)} outside this PR`,
        hot: symbol.outsideCallerFiles > 0,
        paths: symbol.outsidePaths,
      })),
    },
    untested: {
      label: "Untested reach",
      hint: "changed code with no test in this PR",
      empty: "Every changed file is named by a test this pull request changes.",
      items: reach.untested.map((item) => ({
        name: item.path,
        count: "changed, no test in this PR names it",
        hot: true,
        paths: [],
      })),
    },
    removed: {
      label: "Removed, still referenced",
      empty: "Nothing the patch removed is still named outside it.",
      items: reach.removedStillReferenced.map((item) => ({
        name: item.name,
        count: `${files(item.paths.length)} still name it`,
        hot: true,
        paths: item.paths,
      })),
    },
  };
}

/** Why the Reach block is missing, in the one line the reader shows in its place. */
export const BRIEF_REACH_UNAVAILABLE_LABELS = {
  worktree_unavailable: "the represented worktree could not be read",
  head_mismatch: "the worktree no longer stands at this revision",
  search_failed: "the search over the worktree failed",
  timed_out: "the search over the worktree ran out of time",
} as const satisfies Record<NonNullable<Brief["reachUnavailable"]>, string>;

/** A Brief the projection did not carry reads as one that was never generated. */
export const NOT_GENERATED_BRIEF: BriefInsight = { status: "not_generated" };

/**
 * The short text one citation chip carries. The manifest label is the whole
 * evidence -- a paragraph, a commit subject, a hunk header -- so the chip shows
 * the shortest thing that names it and the full label stays in the chip title.
 */
export function briefCitationChipLabel(citation: BriefCitation): string {
  if (citation.kind === "description")
    return `desc ¶${citation.alias.slice(1)}`;
  if (citation.kind === "commit")
    return citation.label.split(" ")[0] ?? citation.alias;
  return citation.path ?? citation.label;
}

/** One line of the Ownership tree: a changed file, how it changed, and its note. */
export type BriefOwnershipRow = {
  readonly path: string;
  /** The file name alone; the directory is printed once, on the group above. */
  readonly name: string;
  readonly status: BriefOwnership["files"][number]["status"];
  readonly note?: string;
};

/** One directory of the Ownership tree, already cut to what the reader draws. */
export type BriefOwnershipDirectory = {
  /** `""` for a file at the repository root. */
  readonly directory: string;
  readonly files: ReadonlyArray<BriefOwnershipRow>;
  /** Files past the collapse limit, reported as a count instead of drawn. */
  readonly hidden: number;
};

/** Past this many files, one directory would push the rest of the tree off screen. */
const MAX_OWNERSHIP_DIRECTORY_FILES = 12;

/**
 * Groups the Ownership skeleton into the directory rows the tree draws, keeping the
 * skeleton's path order. A directory with more than 12 files is cut to 12 and
 * reports the rest as a count, so a wide directory cannot bury the others.
 */
export function briefOwnershipTree(
  ownership: BriefOwnership,
): ReadonlyArray<BriefOwnershipDirectory> {
  const notes = new Map(ownership.notes.map((note) => [note.path, note.note]));
  const groups = new Map<string, Array<BriefOwnershipRow>>();
  for (const file of ownership.files) {
    const cut = file.path.lastIndexOf("/");
    const directory = cut < 0 ? "" : file.path.slice(0, cut + 1);
    const rows = groups.get(directory) ?? [];
    rows.push({
      path: file.path,
      name: file.path.slice(cut + 1),
      status: file.status,
      ...definedProps({ note: notes.get(file.path) }),
    });
    groups.set(directory, rows);
  }
  return [...groups].map(([directory, rows]) => ({
    directory,
    files: rows.slice(0, MAX_OWNERSHIP_DIRECTORY_FILES),
    hidden: Math.max(0, rows.length - MAX_OWNERSHIP_DIRECTORY_FILES),
  }));
}

/** "6 verified · 1 assumption": what the Brief could cite, and what it could not. */
export function briefCitationStatusLine(brief: Brief): string {
  const verified = brief.goal.reduce(
    (total, item) => total + item.citations.length,
    0,
  );
  const assumptions = brief.assumptions.length;
  return `${verified} verified · ${assumptions} ${assumptions === 1 ? "assumption" : "assumptions"}`;
}
