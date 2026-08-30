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
