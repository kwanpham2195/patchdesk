import * as v from "valibot";

import type { BriefOwnershipFile } from "./brief-ownership";
import { definedProps } from "./defined-props";

/*
 * The Brief reader draws this block as the "Start here" card: one sentence of
 * reading advice, then the first files to read, in the order to read them.
 *
 * The order is the whole information here, so the reader numbers it. A path
 * survives only when it is one of the changed, non-generated files the
 * Ownership skeleton kept -- a reading order that names a file outside the
 * diff is the model naming something it did not read -- and the block is
 * dropped whole when nothing survives, because a reading order of length zero
 * advises nothing.
 */

/** One sentence, so the card leads with advice rather than a paragraph. */
const MAX_START_HERE_LEAD_LENGTH = 200;
/** A why is a clause beside a path, not a second sentence. */
const MAX_START_HERE_WHY_LENGTH = 120;
/** Past five files this stops being a place to start and becomes the diff again. */
const MAX_START_HERE_FILES = 5;
const MAX_START_HERE_INPUT_TEXT_LENGTH = 400;
const MAX_START_HERE_INPUT_FILES = 20;
const MAX_START_HERE_PATH_LENGTH = 1_024;

/**
 * One file of the reading order. `path` is plain text, like
 * `BriefOwnershipFile.path`: it is a display line matched against the patch's
 * own changed files, never a path Patchdesk opens.
 */
type BriefStartHereFile = {
  readonly path: string;
  readonly why?: string;
};

/** The Start here block: one sentence of reading advice, then the files in order. */
export type BriefStartHere = {
  readonly lead: string;
  readonly order: ReadonlyArray<BriefStartHereFile>;
};

/**
 * The Start here keys a Brief child may return. The child proposes both the
 * advice and the order; Patchdesk decides which of the proposed paths are real.
 */
export const briefStartHereOutputSchema = v.optional(
  v.strictObject({
    lead: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(MAX_START_HERE_INPUT_TEXT_LENGTH),
    ),
    order: v.pipe(
      v.array(
        v.strictObject({
          path: v.pipe(
            v.string(),
            v.minLength(1),
            v.maxLength(MAX_START_HERE_PATH_LENGTH),
          ),
          why: v.optional(
            v.pipe(
              v.string(),
              v.minLength(1),
              v.maxLength(MAX_START_HERE_INPUT_TEXT_LENGTH),
            ),
          ),
        }),
      ),
      v.maxLength(MAX_START_HERE_INPUT_FILES),
    ),
  }),
);

export type BriefStartHereOutput = v.InferOutput<
  typeof briefStartHereOutputSchema
>;

/** The Start here block that survived normalization, and what it cost in citations. */
export type NormalizedBriefStartHere = {
  readonly value: BriefStartHere | undefined;
  readonly rejected: number;
};

/**
 * Cuts the proposed reading order down to the changed files it may name.
 *
 * Only an exact path match survives, duplicates are dropped, and the order
 * stops at five. A block left with no path (or no advice) is dropped whole and
 * counted once, exactly like a rejected Ownership contract, so the Brief's
 * citation status records that the model offered something Patchdesk refused.
 */
export function normalizeBriefStartHere(
  raw: BriefStartHereOutput,
  files: ReadonlyArray<BriefOwnershipFile>,
): NormalizedBriefStartHere {
  if (raw === undefined) return { value: undefined, rejected: 0 };
  const lead = raw.lead.trim().slice(0, MAX_START_HERE_LEAD_LENGTH);
  const changedPaths = new Set(files.map((file) => file.path));
  const order: Array<BriefStartHereFile> = [];
  const seen = new Set<string>();
  for (const item of raw.order) {
    if (!changedPaths.has(item.path) || seen.has(item.path)) continue;
    seen.add(item.path);
    const why = item.why?.trim().slice(0, MAX_START_HERE_WHY_LENGTH);
    order.push({
      path: item.path,
      ...definedProps({ why: why === "" ? undefined : why }),
    });
    if (order.length === MAX_START_HERE_FILES) break;
  }
  if (lead === "" || order.length === 0)
    return { value: undefined, rejected: 1 };
  return { value: { lead, order }, rejected: 0 };
}
