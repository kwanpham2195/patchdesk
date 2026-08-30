import * as v from "valibot";

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

/** "6 verified · 1 assumption": what the Brief could cite, and what it could not. */
export function briefCitationStatusLine(brief: Brief): string {
  const verified = brief.goal.reduce(
    (total, item) => total + item.citations.length,
    0,
  );
  const assumptions = brief.assumptions.length;
  return `${verified} verified · ${assumptions} ${assumptions === 1 ? "assumption" : "assumptions"}`;
}
