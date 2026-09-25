import * as v from "valibot";

/** One Local draft as the workbench lists it (`LocalDraftEntry` in `src/domain/local-draft.ts`). */
export const localDraftEntrySchema = v.strictObject({
  findingId: v.pipe(v.string(), v.minLength(1)),
  analysisRunId: v.pipe(v.string(), v.minLength(1)),
  sessionId: v.pipe(v.string(), v.minLength(1)),
  path: v.pipe(v.string(), v.minLength(1)),
  side: v.picklist(["new", "old"]),
  startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
  line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  title: v.pipe(v.string(), v.minLength(1)),
  suggests: v.boolean(),
});

/** What Add to draft and Remove answer with: the whole list after the change. */
export const localDraftListSchema = v.strictObject({
  localDrafts: v.array(localDraftEntrySchema),
});

export type LocalDraftEntry = v.InferOutput<typeof localDraftEntrySchema>;
