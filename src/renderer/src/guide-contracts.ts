import * as v from "valibot";
import { retainedGuideSchema, parseRetainedGuide } from "#src/domain/guide";
import {
  guideReadingStateSchema,
  validateGuideReadingContent,
} from "#src/domain/guide-reading-state";
import { insightFields, retainedInsightFields } from "./insight-contracts";

/** Guide projection binds reading progress and complete evidence to its retained result. */
export const guideInsightSchema = v.pipe(
  v.strictObject({
    ...insightFields,
    readingState: v.optional(guideReadingStateSchema),
    retained: v.optional(
      v.strictObject({
        ...retainedInsightFields,
        freshness: v.picklist(["current", "outdated"]),
        value: v.pipe(
          retainedGuideSchema,
          v.check((value) => parseRetainedGuide(value)._tag === "ok"),
        ),
      }),
    ),
  }),
  v.check(
    (insight) =>
      insight.readingState === undefined ||
      (insight.retained !== undefined &&
        insight.readingState.runId === insight.retained.runId &&
        insight.readingState.sessionId === insight.retained.sessionId &&
        validateGuideReadingContent(
          insight.readingState,
          insight.retained.value,
        )._tag === "ok"),
  ),
);
