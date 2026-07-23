import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import * as v from "valibot";

import { err, ok, type Result } from "../../domain/result";

/** A renderer-safe description of a Pi model enabled for this local runtime. */
export type PiRuntimeModel = {
  readonly id: string;
  readonly label: string;
};

export type PiRuntimeModelCatalog = {
  get(): Promise<Result<PiRuntimeModelCatalogSnapshot, PiRuntimeModelCatalogUnavailable>>;
};

export type PiRuntimeModelCatalogSnapshot = {
  readonly models: ReadonlyArray<PiRuntimeModel>;
  readonly defaultModel?: string;
};

export type PiRuntimeModelCatalogUnavailable = {
  readonly _tag: "PiRuntimeModelCatalogUnavailable";
};

const settingsSchema = v.object({
  enabledModels: v.optional(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(200)))),
  defaultModel: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
});

/**
 * Reads only the allowlisted, non-secret Pi model settings. The settings document itself
 * never crosses the main-process boundary or appears in diagnostics.
 */
export class LocalPiRuntimeModelCatalog implements PiRuntimeModelCatalog {
  constructor(
    private readonly settingsPath = join(homedir(), ".pi", "agent", "settings.json"),
  ) {}

  async get(): Promise<Result<PiRuntimeModelCatalogSnapshot, PiRuntimeModelCatalogUnavailable>> {
    const raw = await readFile(this.settingsPath, "utf8").catch(() => undefined);
    if (raw === undefined) return unavailable();
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return unavailable();
    }
    const parsed = v.safeParse(settingsSchema, decoded);
    if (!parsed.success) return unavailable();
    const enabled = parsed.output.enabledModels ?? [];
    const defaultModel = parsed.output.defaultModel;
    const selected = defaultModel !== undefined && enabled.includes(defaultModel)
      ? [defaultModel, ...enabled.filter((model) => model !== defaultModel)]
      : enabled;
    const models = projectModels(selected);
    return models.length === 0
      ? unavailable()
      : ok({
          models,
          ...(defaultModel !== undefined && models.some((model) => model.id === defaultModel)
            ? { defaultModel }
            : {}),
        });
  }
}

function projectModels(models: ReadonlyArray<string>): ReadonlyArray<PiRuntimeModel> {
  return [...new Set(models)].map((id) => ({ id, label: id }));
}

function unavailable(): Result<never, PiRuntimeModelCatalogUnavailable> {
  return err({ _tag: "PiRuntimeModelCatalogUnavailable" });
}
