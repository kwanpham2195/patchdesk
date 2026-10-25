/** Insight provider and model catalog contracts parsed at the local API boundary. */

import * as v from "valibot";

import { INSIGHT_PROVIDERS } from "#src/domain/insight-provider";

export const insightProviderModelSchema = v.strictObject({
  provider: v.picklist(INSIGHT_PROVIDERS),
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  reasoning: v.pipe(
    v.array(v.picklist(["minimal", "low", "medium", "high", "xhigh"])),
    v.maxLength(8),
  ),
  defaultReasoning: v.optional(
    v.picklist(["minimal", "low", "medium", "high", "xhigh"]),
  ),
  cost: v.optional(
    v.strictObject({
      input: v.pipe(v.number(), v.finite(), v.minValue(0)),
      output: v.pipe(v.number(), v.finite(), v.minValue(0)),
    }),
  ),
});

export type InsightProviderCatalogModel = v.InferOutput<
  typeof insightProviderModelSchema
>;

const insightProviderCatalogSchema = v.strictObject({
  providers: v.array(
    v.strictObject({
      id: v.picklist(INSIGHT_PROVIDERS),
      label: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
      available: v.boolean(),
      supportedTypes: v.array(
        v.picklist(["brief", "analysis", "guide", "walkthrough"]),
      ),
      guidance: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(240),
        v.check(
          (value) => !/(?:^|\s)\/[^\s]+|[A-Za-z]:[\\/]/u.test(value),
          "unsafe provider guidance",
        ),
      ),
    }),
  ),
  models: v.array(insightProviderModelSchema),
});

export type InsightProviderCatalog = v.InferOutput<
  typeof insightProviderCatalogSchema
>;

/** Rejects malformed passive or activated Insight provider catalogs. */
export function parseInsightProviderCatalog(
  input: unknown,
): InsightProviderCatalog | undefined {
  const parsed = v.safeParse(insightProviderCatalogSchema, input);
  return parsed.success ? parsed.output : undefined;
}
