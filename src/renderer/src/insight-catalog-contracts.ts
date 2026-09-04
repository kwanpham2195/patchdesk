/** Insight provider and model catalog contracts parsed at the local API boundary. */

import * as v from "valibot";

const modelCatalogEntrySchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
});

const providerStatusSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  configured: v.boolean(),
  source: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
  guidance: v.pipe(v.string(), v.minLength(1), v.maxLength(240)),
});

const modelCatalogSchema = v.strictObject({
  // The backend advertises the complete universal non-OAuth catalog. It may be
  // empty when no eligible provider is configured and can exceed any small
  // arbitrary count; each entry remains individually bounded above.
  models: v.array(modelCatalogEntrySchema),
  providers: v.optional(v.pipe(v.array(providerStatusSchema), v.maxLength(64))),
  defaultModel: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  ),
  defaultReasoning: v.optional(v.picklist(["low", "medium", "high"])),
  reasoning: v.optional(v.array(v.picklist(["low", "medium", "high"]))),
});

export type ModelCatalog = v.InferOutput<typeof modelCatalogSchema>;

/** Reject malformed Pi model catalog responses; renderer keeps the strict shape only. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser; there is no earlier boundary to run it at.
export function parseModelCatalog(input: unknown): ModelCatalog | undefined {
  const parsed = v.safeParse(modelCatalogSchema, input);
  return parsed.success ? parsed.output : undefined;
}

export const insightProviderModelSchema = v.strictObject({
  provider: v.picklist(["pi", "codex-cli-account"]),
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  reasoning: v.pipe(
    v.array(v.picklist(["minimal", "low", "medium", "high", "xhigh"])),
    v.maxLength(8),
  ),
  defaultReasoning: v.optional(
    v.picklist(["minimal", "low", "medium", "high", "xhigh"]),
  ),
});

export type InsightProviderCatalogModel = v.InferOutput<
  typeof insightProviderModelSchema
>;

const insightProviderCatalogSchema = v.strictObject({
  providers: v.array(
    v.strictObject({
      id: v.picklist(["pi", "codex-cli-account"]),
      label: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
      available: v.boolean(),
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
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): InsightProviderCatalog | undefined {
  const parsed = v.safeParse(insightProviderCatalogSchema, input);
  return parsed.success ? parsed.output : undefined;
}
