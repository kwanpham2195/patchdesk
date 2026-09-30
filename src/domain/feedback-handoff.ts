import * as v from "valibot";

import { definedProps } from "./defined-props";
import { parseIsoTimestamp, type IsoTimestamp } from "./ids";
import { err, ok, type Result } from "./result";

/** What the maintainer may add to a hand-off (ADR 0052 "Feedback hand-off"). */
export const feedbackHandoffVerdicts = [
  "looks_good",
  "changes_requested",
] as const;

export type FeedbackHandoffVerdict = (typeof feedbackHandoffVerdicts)[number];

/**
 * The maintainer's mark that a local Review's Local drafts are ready for the
 * coding agent: Ready for agent, or Copy as agent prompt, which carries no
 * verdict. A later hand-off replaces it, and a move to a new session clears it.
 */
export type FeedbackHandoff = {
  readonly at: IsoTimestamp;
  readonly verdict?: FeedbackHandoffVerdict;
  /** The first Local draft add, edit, or removal after `at`; absent while the drafts are as handed off. */
  readonly draftsChangedAt?: IsoTimestamp;
};

export const storedFeedbackHandoffSchema = v.strictObject({
  at: v.string(),
  verdict: v.optional(v.picklist(feedbackHandoffVerdicts)),
  draftsChangedAt: v.optional(v.string()),
});

export function parseFeedbackHandoff(
  raw: v.InferOutput<typeof storedFeedbackHandoffSchema>,
): Result<FeedbackHandoff, { readonly _tag: "InvalidFeedbackHandoff" }> {
  const at = parseIsoTimestamp(raw.at);
  const draftsChangedAt =
    raw.draftsChangedAt === undefined
      ? ok(undefined)
      : parseIsoTimestamp(raw.draftsChangedAt);
  if (at._tag === "err" || draftsChangedAt._tag === "err")
    return err({ _tag: "InvalidFeedbackHandoff" });
  return ok({
    at: at.value,
    ...definedProps({
      verdict: raw.verdict,
      draftsChangedAt: draftsChangedAt.value,
    }),
  });
}

/**
 * The hand-off as the workbench and `get_feedback` read it: when and with
 * which verdict, and whether a draft was added, edited, or removed since.
 */
export type FeedbackHandoffReading = {
  readonly handoff: {
    readonly at: IsoTimestamp;
    readonly verdict?: FeedbackHandoffVerdict;
  };
  readonly changedSinceHandoff: boolean;
};

/** The wire form of `FeedbackHandoffReading` the renderer parses. */
export const feedbackHandoffReadingSchema = v.strictObject({
  handoff: v.strictObject({
    at: v.string(),
    verdict: v.exactOptional(v.picklist(feedbackHandoffVerdicts)),
  }),
  changedSinceHandoff: v.boolean(),
});

export function readFeedbackHandoff(
  handoff: FeedbackHandoff | undefined,
): FeedbackHandoffReading | undefined {
  if (handoff === undefined) return undefined;
  return {
    handoff: {
      at: handoff.at,
      ...definedProps({ verdict: handoff.verdict }),
    },
    changedSinceHandoff: handoff.draftsChangedAt !== undefined,
  };
}

/** The hand-off a Review keeps after a Local draft change at `at`; the first change after the hand-off is the one recorded. */
export function handoffAfterDraftChange(
  handoff: FeedbackHandoff | undefined,
  at: IsoTimestamp,
): FeedbackHandoff | undefined {
  return handoff === undefined || handoff.draftsChangedAt !== undefined
    ? handoff
    : { ...handoff, draftsChangedAt: at };
}
