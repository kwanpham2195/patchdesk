import * as v from "valibot";

import { guideOthers, type RetainedGuide } from "./guide";
import { parseInsightRunId, parseReviewSessionId } from "./ids";
import type { RetainedInsight } from "./insight-record";
import { err, ok, type Result } from "./result";

const groupId = v.pipe(v.string(), v.regex(/^g[1-9]\d*$/));
const fileId = v.pipe(v.string(), v.regex(/^f[1-9]\d*$/));
const appearanceSchema = v.strictObject({
  groupId: v.union([groupId, v.literal("others")]),
  fileId,
});
const offset = v.pipe(v.number(), v.finite());
const anchorSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("top") }),
  v.strictObject({ kind: v.literal("group"), groupId, offset }),
  v.strictObject({
    kind: v.literal("file"),
    ...appearanceSchema.entries,
    offset,
  }),
]);
/** App-owned reading state, separate from the provider's Guide output. */
export const guideReadingContentSchema = v.strictObject({
  reviewedGroupIds: v.array(groupId),
  expandedAppearances: v.array(appearanceSchema),
  anchor: anchorSchema,
});
/** Durable identity and version are checked against the retained result on every read. */
export const guideReadingStateSchema = v.strictObject({
  runId: v.pipe(
    v.string(),
    v.rawTransform(({ dataset, addIssue, NEVER }) => {
      const parsed = parseInsightRunId(dataset.value);
      if (parsed._tag === "err") {
        addIssue({ message: "Invalid Guide run identifier" });
        return NEVER;
      }
      return parsed.value;
    }),
  ),
  sessionId: v.pipe(
    v.string(),
    v.rawTransform(({ dataset, addIssue, NEVER }) => {
      const parsed = parseReviewSessionId(dataset.value);
      if (parsed._tag === "err") {
        addIssue({ message: "Invalid Guide session identifier" });
        return NEVER;
      }
      return parsed.value;
    }),
  ),
  version: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  ...guideReadingContentSchema.entries,
});
/** Local edits do not choose durable result identity or version. */
export type GuideReadingContent = v.InferOutput<
  typeof guideReadingContentSchema
>;
/** Saved progress belongs to one retained run and its represented session. */
export type GuideReadingState = v.InferOutput<typeof guideReadingStateSchema>;

/** Absence alone selects the initial state; malformed explicit state is never reset. */
export function initialGuideReadingState(
  retained: RetainedInsight<RetainedGuide>,
): GuideReadingState {
  return {
    runId: retained.runId,
    sessionId: retained.revision.sessionId,
    version: 0,
    reviewedGroupIds: [],
    expandedAppearances: [],
    anchor: { kind: "top" },
  };
}

/** Establishes membership and uniqueness after the owning boundary parses the shape. */
export function validateGuideReadingContent(
  content: GuideReadingContent,
  guide: RetainedGuide,
): Result<GuideReadingContent, "invalid_reading_state"> {
  const groups = new Set(guide.groups.map((group) => String(group.id)));
  const appearances = new Set([
    ...guide.groups.flatMap((group) =>
      group.files.map((file) => `${group.id}/${file.fileId}`),
    ),
    ...guideOthers(guide).map((file) => `others/${file.id}`),
  ]);
  const expanded = content.expandedAppearances.map(
    (appearance) => `${appearance.groupId}/${appearance.fileId}`,
  );
  if (
    new Set(content.reviewedGroupIds).size !==
      content.reviewedGroupIds.length ||
    content.reviewedGroupIds.some((id) => !groups.has(id)) ||
    new Set(expanded).size !== expanded.length ||
    expanded.some((key) => !appearances.has(key))
  )
    return err("invalid_reading_state");
  switch (content.anchor.kind) {
    case "top":
      break;
    case "group":
      if (
        !groups.has(content.anchor.groupId) ||
        !Number.isFinite(content.anchor.offset)
      )
        return err("invalid_reading_state");
      break;
    case "file":
      if (
        !appearances.has(
          `${content.anchor.groupId}/${content.anchor.fileId}`,
        ) ||
        !Number.isFinite(content.anchor.offset)
      )
        return err("invalid_reading_state");
      break;
  }
  return ok(content);
}

/** Refuses persisted progress that names another result or represented session. */
export function validateGuideReadingState(
  state: GuideReadingState,
  retained: RetainedInsight<RetainedGuide>,
): Result<GuideReadingState, "invalid_reading_state"> {
  if (
    state.runId !== retained.runId ||
    state.sessionId !== retained.revision.sessionId ||
    !Number.isSafeInteger(state.version) ||
    state.version < 0
  )
    return err("invalid_reading_state");
  const content = validateGuideReadingContent(state, retained.value);
  return content._tag === "err" ? content : ok(state);
}
