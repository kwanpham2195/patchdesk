import * as v from "valibot";
import { retainedGuideSchema, parseRetainedGuide } from "#src/domain/guide";
import { insightFields, retainedInsightFields } from "./insight-contracts";

/** Guide projection uses its own complete snapshot rather than the current workbench patch. */
export const guideInsightSchema = v.strictObject({
  ...insightFields,
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
});
