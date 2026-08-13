import { createHash } from "node:crypto";

import * as v from "valibot";

import { generatedPiAiCatalog } from "./pi-ai-catalog.generated";

const modelSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(1)),
  provider: v.pipe(v.string(), v.minLength(1)),
});
const providerSchema = v.strictObject({
  provider: v.pipe(v.string(), v.minLength(1)),
  models: v.array(modelSchema),
});
const artifactSchema = v.strictObject({
  piVersion: v.literal("0.84.1"),
  catalog: v.array(providerSchema),
  digest: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});

type PiAiModel = v.InferOutput<typeof modelSchema>;

/** Generated from runtime/flue's exact Pi catalog; this root module never imports Pi. */
function parseGeneratedCatalog(input: unknown): ReadonlyArray<{ readonly provider: string; readonly models: ReadonlyArray<PiAiModel> }> {
  const parsed = v.safeParse(artifactSchema, input);
  if (!parsed.success || !matchesDigest(parsed.output)) throw new Error("Invalid generated Pi model catalog artifact");
  return parsed.output.catalog.map(({ provider, models }) => ({
    provider,
    models: models.filter((model) => model.provider === provider),
  }));
}

function matchesDigest(artifact: v.InferOutput<typeof artifactSchema>): boolean {
  return createHash("sha256")
    .update(JSON.stringify({ piVersion: artifact.piVersion, catalog: artifact.catalog }))
    .digest("hex") === artifact.digest;
}

export const PI_AI_CATALOG = parseGeneratedCatalog(generatedPiAiCatalog);
export { parseGeneratedCatalog };
