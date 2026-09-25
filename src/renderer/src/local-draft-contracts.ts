import * as v from "valibot";

const nonEmpty = v.pipe(v.string(), v.minLength(1));
const lineNumber = v.pipe(v.number(), v.integer(), v.minValue(1));
const location = {
  sessionId: nonEmpty,
  path: nonEmpty,
  side: v.picklist(["new", "old"]),
  startLine: lineNumber,
  line: lineNumber,
  /** Absent until the Review first moves to a new session (#452). */
  state: v.exactOptional(
    v.picklist(["unchanged", "changed", "needs_attention", "applied"]),
  ),
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

/** What every Local draft command answers with: the whole list after the change. */
export const localDraftListSchema = v.strictObject({
  localDrafts: v.array(localDraftEntrySchema),
});

export type LocalDraftEntry = v.InferOutput<typeof localDraftEntrySchema>;
