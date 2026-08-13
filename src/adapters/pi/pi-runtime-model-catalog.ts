import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import * as v from "valibot";

import { err, ok, type Result } from "../../domain/result";
import { PI_AI_CATALOG } from "./pi-ai-catalog";
import {
  LocalPiProviderCatalog,
  providerCatalog,
  type PiProviderCatalog,
  type PiProviderStatus,
} from "./pi-provider-catalog";

/** A renderer-safe description of an eligible Pi model enabled for this local runtime. */
export type PiRuntimeModel = {
  readonly id: string;
  readonly label: string;
};

export type PiRuntimeModelCatalog = {
  get(): Promise<
    Result<PiRuntimeModelCatalogSnapshot, PiRuntimeModelCatalogUnavailable>
  >;
};

export type PiRuntimeModelCatalogSnapshot = {
  readonly models: ReadonlyArray<PiRuntimeModel>;
  readonly defaultModel?: string;
  readonly providers?: ReadonlyArray<PiProviderStatus>;
  readonly configured?: boolean;
};

export type PiRuntimeModelCatalogUnavailable = {
  readonly _tag: "PiRuntimeModelCatalogUnavailable";
};

const settingsSchema = v.object({
  enabledModels: v.optional(
    v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  ),
  defaultModel: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  ),
});

/**
 * Reads only the allowlisted, non-secret Pi model settings. The settings document itself
 * never crosses the main-process boundary or appears in diagnostics.
 */
export class LocalPiRuntimeModelCatalog implements PiRuntimeModelCatalog {
  private readonly providers: LocalPiProviderCatalog;

  constructor(
    private readonly settingsPath = join(
      homedir(),
      ".pi",
      "agent",
      "settings.json",
    ),
    providers?: LocalPiProviderCatalog,
  ) {
    this.providers = providers ?? new LocalPiProviderCatalog();
  }

  async get(): Promise<
    Result<PiRuntimeModelCatalogSnapshot, PiRuntimeModelCatalogUnavailable>
  > {
    const providerCatalog = await this.providers.get();
    if (providerCatalog._tag === "err") return unavailable();
    const raw = await readFile(this.settingsPath, "utf8").catch(
      () => undefined,
    );
    const preferences = readPreferences(raw);
    const preferred =
      preferences.defaultModel === undefined
        ? preferences.enabledModels
        : [
            preferences.defaultModel,
            ...preferences.enabledModels.filter(
              (model) => model !== preferences.defaultModel,
            ),
          ];
    const configuredProviders = new Set(
      providerCatalog.value.providers
        .filter((provider) => provider.configured)
        .map((provider) => provider.id),
    );
    const models = projectModels(preferred, configuredProviders);
    const defaultModel = canonicalModelId(preferences.defaultModel);
    return snapshot(
      models,
      defaultModel !== undefined &&
        models.some((model) => model.id === defaultModel)
        ? defaultModel
        : undefined,
      providerCatalog.value,
    );
  }
}

function snapshot(
  models: ReadonlyArray<PiRuntimeModel>,
  defaultModel: string | undefined,
  providers: PiProviderCatalog,
): Result<PiRuntimeModelCatalogSnapshot, PiRuntimeModelCatalogUnavailable> {
  return ok({
    models,
    ...(defaultModel === undefined ? {} : { defaultModel }),
    providers: providers.providers,
    configured: providers.configured,
  });
}

function readPreferences(raw: string | undefined): {
  enabledModels: ReadonlyArray<string>;
  defaultModel?: string;
} {
  if (raw === undefined) return { enabledModels: [] };
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { enabledModels: [] };
  }
  const parsed = v.safeParse(settingsSchema, decoded);
  return parsed.success
    ? {
        enabledModels: parsed.output.enabledModels ?? [],
        ...(parsed.output.defaultModel === undefined
          ? {}
          : { defaultModel: parsed.output.defaultModel }),
      }
    : { enabledModels: [] };
}

function projectModels(
  preferred: ReadonlyArray<string>,
  configuredProviders: ReadonlySet<string>,
): ReadonlyArray<PiRuntimeModel> {
  const preferredIds = new Map<string, number>();
  for (const [index, raw] of preferred.entries()) {
    const id = canonicalModelId(raw);
    if (id !== undefined && !preferredIds.has(id)) preferredIds.set(id, index);
  }

  // Pi settings are preferences, not an inclusion gate. The installed pi-ai catalog is
  // authoritative for the complete static model set; only configured allowlisted providers
  // survive the final projection.
  const catalog = PI_AI_CATALOG.filter(({ provider }) =>
    providerCatalog().some((definition) => definition.id === provider),
  )
    .flatMap(({ models }) => models)
    .map((model) => ({
      id: canonicalModelId(`${model.provider}/${model.id}`),
      label: `${model.provider}/${model.id}`,
    }))
    .filter(
      (model): model is { id: string; label: string } => model.id !== undefined,
    );
  const eligible = catalog.filter((model) =>
    configuredProviders.has(model.id.slice(0, model.id.indexOf("/"))),
  );
  const seen = new Set<string>();
  return [...eligible]
    .sort(
      (left, right) =>
        (preferredIds.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (preferredIds.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    )
    .filter((model) => !seen.has(model.id) && seen.add(model.id));
}

/** Canonical provider/model IDs. OAuth, custom, and malformed identifiers return undefined. */
export function canonicalModelId(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const provider = value.slice(0, separator).toLowerCase();
  const model = value.slice(separator + 1);
  return provider.length > 0 &&
    model.length > 0 &&
    /^[a-z0-9][a-z0-9._:-]*$/i.test(provider) &&
    /^(?:[^\s/]+\/)*[^\s/]+$/.test(model) &&
    providerCatalogIds.has(provider)
    ? `${provider}/${model}`
    : undefined;
}

const providerCatalogIds = new Set([
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "azure-openai-responses",
  "cerebras",
  "cloudflare-ai-gateway",
  "deepseek",
  "fireworks",
  "google",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "nvidia",
  "openai",
  "opencode",
  "opencode-go",
  "openrouter",
  "together",
  "vercel-ai-gateway",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
]);

function unavailable(): Result<never, PiRuntimeModelCatalogUnavailable> {
  return err({ _tag: "PiRuntimeModelCatalogUnavailable" });
}
