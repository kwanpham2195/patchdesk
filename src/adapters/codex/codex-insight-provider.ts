import * as v from "valibot";
import { rawJsonValueSchema } from "#src/domain/json";
import { err, ok, type Result } from "#src/domain/result";
import type { JsonObject } from "./codex-app-server-client";

const definitions = v.nullable(
  v.record(v.string(), v.record(v.string(), rawJsonValueSchema)),
);
const configSchema = v.looseObject({
  config: v.looseObject({
    model_provider: v.nullable(v.pipe(v.string(), v.nonEmpty())),
    model_providers: v.optional(definitions),
    openai_base_url: v.optional(v.nullable(v.string())),
    chatgpt_base_url: v.optional(v.nullable(v.string())),
  }),
});
const requirementsSchema = v.looseObject({
  requirements: v.nullable(
    v.looseObject({
      modelProvider: v.nullable(v.pipe(v.string(), v.nonEmpty())),
      modelProviders: definitions,
      chatgptBaseUrl: v.optional(v.nullable(v.string())),
    }),
  ),
});

export type CodexInsightProvider = {
  readonly id: string;
  readonly settings: JsonObject;
};

/** Config/read merges process overrides but leaves native defaults null; managed requirements still win. */
export function resolveCodexInsightProvider(
  config: JsonObject,
  requirements: JsonObject,
  nativeVersion: string | undefined,
): Result<CodexInsightProvider, "native_policy_unsupported"> {
  const configured = v.safeParse(configSchema, config);
  const managed = v.safeParse(requirementsSchema, requirements);
  if (!configured.success || !managed.success)
    return err("native_policy_unsupported");
  const value = configured.output.config;
  const required = managed.output.requirements;
  const selected = required?.modelProvider ?? value.model_provider;
  // Only this verified native version's default is supported, not an assumed default for unknown servers.
  if (
    selected === null &&
    nativeVersion !== "0.162.1" &&
    nativeVersion !== "0.163.0"
  )
    return err("native_policy_unsupported");
  const id = selected ?? "openai";
  const definition =
    required?.modelProviders?.[id] ?? value.model_providers?.[id] ?? null;
  return ok({
    id,
    settings: {
      definition,
      openaiBaseUrl: value.openai_base_url ?? null,
      chatgptBaseUrl:
        required?.chatgptBaseUrl ?? value.chatgpt_base_url ?? null,
    },
  });
}
