import * as v from "valibot";

import { feedbackHandoffReadingSchema } from "../../domain/feedback-handoff";
import { localDraftReplySchema } from "../../domain/local-draft-reply";

const nonEmpty = v.pipe(v.string(), v.minLength(1));
const lineNumber = v.pipe(v.number(), v.integer(), v.minValue(1));
const location = {
  sessionId: nonEmpty,
  /** The patch view the draft was made on. */
  view: v.picklist(["combined", "committed", "uncommitted"]),
  path: nonEmpty,
  side: v.picklist(["new", "old"]),
  startLine: lineNumber,
  line: lineNumber,
  /** Absent until the Review first moves to a new session (#452). */
  state: v.exactOptional(
    v.picklist(["unchanged", "changed", "needs_attention", "applied"]),
  ),
  /** Present once the maintainer resolved the draft (#600). */
  resolvedAt: v.exactOptional(nonEmpty),
};

/** One Local draft as the workbench lists it (`LocalDraftEntry` in `src/domain/local-draft.ts`). */
export const localDraftEntrySchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("finding"),
    findingId: nonEmpty,
    analysisRunId: nonEmpty,
    ...location,
    title: nonEmpty,
    suggests: v.boolean(),
  }),
  v.strictObject({
    kind: v.literal("note"),
    noteId: nonEmpty,
    ...location,
    text: nonEmpty,
  }),
]);

/** What every Local draft command answers with: the whole list after the change, the agent's replies, and the hand-off when the Review has one. */
export const localDraftListSchema = v.strictObject({
  localDrafts: v.array(localDraftEntrySchema),
  localDraftReplies: v.exactOptional(v.array(localDraftReplySchema)),
  feedbackHandoff: v.exactOptional(feedbackHandoffReadingSchema),
});

export type LocalDraftEntry = v.InferOutput<typeof localDraftEntrySchema>;

/** The coding agent's latest reply to one draft (`LocalDraftReply` in `src/domain/local-draft-reply.ts`). */
export type LocalDraftReplyEntry = v.InferOutput<typeof localDraftReplySchema>;
