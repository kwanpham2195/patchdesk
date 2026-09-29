import * as v from "valibot";

import type { AccountInsightProvider } from "../../domain/insight-provider";
import { definePreference } from "./lib/local-preference";
import {
  insightProviderModelSchema,
  type InsightProviderCatalogModel,
} from "./insight-catalog-contracts";

const VERSION = 1;
/** A pi login with several providers lists hundreds of models; 757 on the 2026-09-30 spike. */
const MAX_MODELS = 2048;

/**
 * Only one provider's catalog is cached per key, so a corrupt or foreign entry
 * rejects the whole list rather than being dropped silently. Unlike a
 * preference, this cache has an authoritative source: the explicit fetch
 * rebuilds it.
 */
function accountModelCache(
  provider: AccountInsightProvider,
  keyPrefix: string,
) {
  return definePreference({
    key: (profileId: string) => `${keyPrefix}.v${VERSION}.${profileId}`,
    schema: v.pipe(
      v.array(insightProviderModelSchema),
      v.maxLength(MAX_MODELS),
      v.check(
        (models) => models.every((model) => model.provider === provider),
        "cached model belongs to another provider",
      ),
    ),
    defaultValue: undefined,
  });
}

const accountModelCaches = {
  "codex-cli-account": accountModelCache(
    "codex-cli-account",
    "patchdesk.codex-models",
  ),
  "pi-cli-account": accountModelCache(
    "pi-cli-account",
    "patchdesk.pi-cli-models",
  ),
} satisfies Record<
  AccountInsightProvider,
  ReturnType<typeof accountModelCache>
>;

/** Loads one account provider's cached model catalog for one profile, rejecting corrupt local storage. */
export function loadAccountModelCache(
  provider: AccountInsightProvider,
  profileId: string,
): ReadonlyArray<InsightProviderCatalogModel> | undefined {
  return accountModelCaches[provider].load(profileId);
}

/** Saves the model catalog an explicit user action fetched for one account provider and profile. */
export function saveAccountModelCache(
  provider: AccountInsightProvider,
  profileId: string,
  models: ReadonlyArray<InsightProviderCatalogModel>,
): void {
  accountModelCaches[provider].save(profileId, [...models]);
}
