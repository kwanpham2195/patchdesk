import * as v from "valibot";

import { definePreference } from "./lib/local-preference";
import {
  insightProviderModelSchema,
  type InsightProviderCatalogModel,
} from "./insight-catalog-contracts";

const VERSION = 1;
const MAX_MODELS = 512;

/**
 * Only this provider's catalog is cached, so a corrupt or foreign entry
 * rejects the whole list rather than being dropped silently. Unlike a
 * preference, this cache has an authoritative source: the explicit fetch
 * rebuilds it.
 */
const codexModelCacheSchema = v.pipe(
  v.array(insightProviderModelSchema),
  v.maxLength(MAX_MODELS),
  v.check(
    (models) => models.every((model) => model.provider === "codex-cli-account"),
    "cached model is not a Codex model",
  ),
);

const codexModelCache = definePreference({
  key: (profileId: string) => `patchdesk.codex-models.v${VERSION}.${profileId}`,
  schema: codexModelCacheSchema,
  defaultValue: undefined,
});

/** Loads the cached Codex model catalog for one profile, rejecting corrupt local storage. */
export function loadCodexModelCache(
  profileId: string,
): ReadonlyArray<InsightProviderCatalogModel> | undefined {
  return codexModelCache.load(profileId);
}

/** Saves the Codex model catalog fetched by an explicit user action, for one profile. */
export function saveCodexModelCache(
  profileId: string,
  models: ReadonlyArray<InsightProviderCatalogModel>,
): void {
  codexModelCache.save(profileId, [...models]);
}
