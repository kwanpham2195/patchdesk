import * as v from "valibot";
import { retainedGuideSchema, parseRetainedGuide } from "#src/domain/guide";
import {
  guideReadingStateSchema,
  validateGuideReadingContent,
} from "#src/domain/guide-reading-state";
import {
  guidePageSchema,
  guideSummarySchema,
  type GuidePage,
  type GuideSummary,
} from "#src/domain/guide-progress";
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

/** Strict parse of the bounded Guide summary reply; anything else is treated as an unreadable Guide. */
export function parseGuideSummaryReply(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this parser validates a bridge reply at its owning input boundary.
  body: unknown,
): GuideSummary | undefined {
  const parsed = v.safeParse(guideSummarySchema, body);
  return parsed.success ? parsed.output : undefined;
}

/** Strict parse of one bounded Guide page reply. */
export function parseGuidePageReply(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this parser validates a bridge reply at its owning input boundary.
  body: unknown,
): GuidePage | undefined {
  const parsed = v.safeParse(guidePageSchema, body);
  return parsed.success ? parsed.output : undefined;
}
