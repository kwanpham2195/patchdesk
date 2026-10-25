import { isAbsolute } from "node:path";
import * as v from "valibot";
import {
  nativeSessionAttemptDetailsSchema,
  type NativeSessionAttempt,
} from "#src/domain/native-session-attempt";

import { err, ok, type Result } from "#src/domain/result";
import type { CodexRunInput, JsonObject } from "./codex-app-server-client";

/** The complete text request, including native reader instructions, fits this bound. */
export const NATIVE_INSIGHT_PROMPT_BYTES = 65_536;
/** Native review decides requests; this instruction grants no client approval. */
export const NATIVE_INSIGHT_INSTRUCTIONS =
  "Inspect only the captured evidence for this Review. Do not modify files, access credentials, use network tools, or publish anything. Honor native permission decisions and report a denied required read without bypassing it.";

const ISOLATED_FEATURES = [
  "hooks",
  "plugins",
  "apps",
  "enable_mcp_apps",
] as const;
const configSchema = v.looseObject({
  config: v.looseObject({
    mcp_servers: v.optional(
      v.record(v.string(), v.looseObject({ enabled: v.optional(v.boolean()) })),
      {},
    ),
    features: v.optional(v.record(v.string(), v.unknown()), {}),
    skills: v.optional(
      v.looseObject({
        include_instructions: v.optional(v.boolean()),
        bundled: v.optional(
          v.looseObject({ enabled: v.optional(v.boolean()) }),
        ),
      }),
    ),
    project_doc_max_bytes: v.optional(v.number()),
    developer_instructions: v.optional(v.nullable(v.string())),
  }),
});
const skillsSchema = v.looseObject({
  data: v.array(
    v.looseObject({
      skills: v.array(
        v.looseObject({ path: v.string(), enabled: v.boolean() }),
      ),
      errors: v.array(v.unknown()),
    }),
  ),
});

/** Process overrides disable resources before any Insight thread starts. */
export function codexInsightIsolationArgs(): ReadonlyArray<string> {
  return [
    ...ISOLATED_FEATURES.flatMap((feature) => ["--disable", feature]),
    "-c",
    "skills.include_instructions=false",
    "-c",
    "skills.bundled.enabled=false",
    "-c",
    "cloud.skills.enabled=false",
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    'developer_instructions=""',
  ];
}

/** Discover selectors without returning stored configuration or skill content. */
export function parseCodexInsightResources(
  config: JsonObject,
  skills: JsonObject,
): Result<ReadonlyArray<string>, "native_isolation_unsupported"> {
  const configured = v.safeParse(configSchema, config);
  const listed = v.safeParse(skillsSchema, skills);
  if (!configured.success || !listed.success || listed.output.data.length === 0)
    return err("native_isolation_unsupported");
  const servers = Object.keys(configured.output.config.mcp_servers);
  const entries = listed.output.data.flatMap((entry) => entry.skills);
  if (
    servers.length > 512 ||
    entries.length > 512 ||
    servers.some((key) => !/^[A-Za-z0-9_-]+$/u.test(key)) ||
    listed.output.data.some((entry) => entry.errors.length !== 0) ||
    entries.some(
      (entry) =>
        !isAbsolute(entry.path) ||
        entry.path.length > 4096 ||
        Array.from(entry.path).some(
          (character) => character.charCodeAt(0) < 32,
        ),
    )
  )
    return err("native_isolation_unsupported");
  return ok([
    ...servers.flatMap((key) => ["-c", `mcp_servers.${key}.enabled=false`]),
    "-c",
    `skills.config=[${entries.map((entry) => `{path=${JSON.stringify(entry.path)},enabled=false}`).join(",")}]`,
  ]);
}

/** Reject ignored overrides or newly loaded resources before sending model input. */
export function codexInsightIsolationConfirmed(
  config: JsonObject,
  skills: JsonObject,
): boolean {
  const configured = v.safeParse(configSchema, config);
  const listed = v.safeParse(skillsSchema, skills);
  if (!configured.success || !listed.success || listed.output.data.length === 0)
    return false;
  const value = configured.output.config;
  return (
    Object.values(value.mcp_servers).every(
      (server) => server.enabled === false,
    ) &&
    ISOLATED_FEATURES.every((feature) => value.features[feature] === false) &&
    value.skills?.include_instructions === false &&
    value.skills.bundled?.enabled === false &&
    value.project_doc_max_bytes === 0 &&
    value.developer_instructions === "" &&
    listed.output.data.every(
      (entry) =>
        entry.errors.length === 0 &&
        entry.skills.every((skill) => skill.enabled === false),
    )
  );
}

const nativeThreadSchema = v.looseObject({
  thread: v.looseObject({ id: v.string() }),
  model: v.string(),
  modelProvider: v.string(),
  reasoningEffort: v.string(),
  approvalPolicy: v.literal("on-request"),
  approvalsReviewer: v.literal("auto_review"),
  sandbox: v.looseObject({ type: v.literal("workspaceWrite") }),
  instructionSources: v.array(v.string()),
});

export function parseCodexInsightSelection(
  value: JsonObject,
): NativeSessionAttempt["observed"] | undefined {
  const parsed = v.safeParse(nativeThreadSchema, value);
  if (!parsed.success) return undefined;
  const selection = v.safeParse(
    nativeSessionAttemptDetailsSchema.entries.observed,
    {
      model: parsed.output.model,
      nativeProvider: parsed.output.modelProvider,
      reasoning: parsed.output.reasoningEffort,
      nativeSessionId: parsed.output.thread.id,
    },
  );
  return selection.success ? selection.output : undefined;
}

/** A managed refusal or effective-policy mismatch never proceeds to turn/start. */
export function parseCodexInsightThread(
  value: JsonObject,
  input: CodexRunInput,
  provider: string,
): string | undefined {
  const parsed = v.safeParse(nativeThreadSchema, value);
  return parsed.success &&
    parsed.output.model === input.model &&
    parsed.output.modelProvider === provider &&
    parsed.output.reasoningEffort === input.reasoning &&
    parsed.output.instructionSources.length === 0
    ? parsed.output.thread.id
    : undefined;
}

/** Creates the restricted environment inherited by the Codex child. */
export function allowlistedCodexEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP"];
  const result: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = environment[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}
