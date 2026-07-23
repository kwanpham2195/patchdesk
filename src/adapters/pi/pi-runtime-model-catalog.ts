import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import * as v from "valibot";

/** A renderer-safe description of a Pi model enabled for this local runtime. */
export type PiRuntimeModel = {
  readonly id: string;
  readonly label: string;
};

export type PiRuntimeModelCatalog = {
  list(): Promise<ReadonlyArray<PiRuntimeModel>>;
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
    private readonly fallback: ReadonlyArray<string> = ["opencode-go/deepseek-v4-flash"],
  ) {}

  async list(): Promise<ReadonlyArray<PiRuntimeModel>> {
    const raw = await readFile(this.settingsPath, "utf8").catch(() => undefined);
    if (raw === undefined) return projectModels(this.fallback);
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return projectModels(this.fallback);
    }
    const parsed = v.safeParse(settingsSchema, decoded);
    if (!parsed.success) return projectModels(this.fallback);
    const enabled = parsed.output.enabledModels ?? [];
    const defaultModel = parsed.output.defaultModel;
    const selected = defaultModel !== undefined && enabled.includes(defaultModel)
      ? [defaultModel, ...enabled.filter((model) => model !== defaultModel)]
      : enabled;
    return projectModels(selected.length === 0 ? this.fallback : selected);
  }
}

function projectModels(models: ReadonlyArray<string>): ReadonlyArray<PiRuntimeModel> {
  return [...new Set(models)].map((id) => ({ id, label: id }));
}
