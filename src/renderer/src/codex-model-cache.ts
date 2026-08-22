import * as v from "valibot";

import {
  insightProviderModelSchema,
  type InsightProviderCatalogModel,
} from "./renderer-contracts";

const VERSION = 1;
const MAX_MODELS = 512;

/**
 * Only this provider's catalog is cached, so a corrupt or foreign entry
 * rejects the whole list rather than being dropped silently.
 */
const codexModelCacheSchema = v.pipe(
  v.array(insightProviderModelSchema),
  v.maxLength(MAX_MODELS),
  v.check(
    (models) => models.every((model) => model.provider === "codex-cli-account"),
    "cached model is not a Codex model",
  ),
);

/** Loads the cached Codex model catalog for one profile, rejecting corrupt local storage. */
export function loadCodexModelCache(
  profileId: string,
): ReadonlyArray<InsightProviderCatalogModel> | undefined {
  try {
    const raw: unknown = JSON.parse(
      window.localStorage.getItem(key(profileId)) ?? "null",
    );
    const parsed = v.safeParse(codexModelCacheSchema, raw);
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}

/** Saves the Codex model catalog fetched by an explicit user action, for one profile. */
export function saveCodexModelCache(
  profileId: string,
  models: ReadonlyArray<InsightProviderCatalogModel>,
): void {
  try {
    window.localStorage.setItem(key(profileId), JSON.stringify(models));
  } catch {
    // Local storage is best effort; a failed write just repeats the explicit
    // fetch next time.
  }
}

function key(profileId: string): string {
  return `patchdesk.codex-models.v${VERSION}.${profileId}`;
}
