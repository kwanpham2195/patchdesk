import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Agent } from "@earendil-works/pi-agent-core";
import {
  createModels,
  retryAssistantCall,
  type Api,
  type AssistantMessageEventStream,
  type Model,
  type Models,
  type Provider,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import * as v from "valibot";

import { CommandRunner } from "../../../src/adapters/github/command-runner";
import { PatchdeskPaths } from "../../../src/adapters/storage/patchdesk-paths";
import { definedProps } from "../../../src/domain/defined-props";
import {
  rawJsonValueSchema,
  type RawJsonValue,
} from "../../../src/domain/json";
import {
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../../src/domain/ids";
import {
  AnalysisPromptTooLargeError,
  prepareModelReview,
  type PreparedModelReview,
} from "../../../src/services/model-review-runner";
import type { ReviewInspector } from "../../../src/services/review-inspector";
import { prepareBriefPrompt } from "../../../src/services/brief-operation";
import { prepareWalkthroughPrompt } from "../../../src/services/walkthrough-operation";

import {
  MAX_RUNTIME_STDIN_BYTES,
  MAX_RUNTIME_STDOUT_BYTES,
  analysisInvocationSchema,
  briefInvocationSchema,
  briefResultSchema,
  productionAnalysisInvocationSchema,
  productionBriefInvocationSchema,
  productionWalkthroughInvocationSchema,
  assertSupportedNode,
  createAnalysisAgent,
  createBriefAgent,
  createWalkthroughAgent,
  loadPatchdeskReviewSkill,
  modelReviewResultSchema,
  walkthroughResultSchema,
  walkthroughInvocationSchema,
  type InsightAgentSpec,
  type InspectorOperations,
} from "./patchdesk-insight-agent";

const childProtocolSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("analysis"),
    input: analysisInvocationSchema,
  }),
  v.strictObject({
    type: v.literal("walkthrough"),
    input: walkthroughInvocationSchema,
  }),
  v.strictObject({
    type: v.literal("brief"),
    input: briefInvocationSchema,
  }),
]);

const productionProtocolSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("analysis"),
    input: productionAnalysisInvocationSchema,
  }),
  v.strictObject({
    type: v.literal("walkthrough"),
    input: productionWalkthroughInvocationSchema,
  }),
  v.strictObject({
    type: v.literal("brief"),
    input: productionBriefInvocationSchema,
  }),
]);

export type PatchdeskChildInvocation = v.InferOutput<
  typeof childProtocolSchema
>;
type ProductionChildInvocation = v.InferOutput<typeof productionProtocolSchema>;
export type PatchdeskChildResult =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid_input"
        | "invalid_result"
        | "runtime_unavailable"
        | "cancelled"
        | "execution_failed";
      /**
       * One bounded, redacted line naming why the provider refused or failed.
       * Without it a provider refusal (an expired account, no credit, a
       * rejected model) is indistinguishable from a malformed model result in
       * both the diagnostic and the failed-state copy.
       */
      readonly detail?: string;
    };

/** Parses one bounded stdin protocol object. */
export function parsePatchdeskChildInvocation(
  input: RawJsonValue,
): PatchdeskChildInvocation | undefined {
  const parsed = v.safeParse(childProtocolSchema, input);
  return parsed.success ? parsed.output : undefined;
}

/**
 * The turn ceiling one child run may reach. Only a tool call continues Pi's
 * agent loop and the inspector budget stops at eight calls, so a well-behaved
 * insight settles far below this; the cap exists to bound a model that keeps
 * calling tools without ever submitting a result.
 */
export const MAX_AGENT_TURNS = 24;

/**
 * How many times the runner restarts one model turn that failed on a transient
 * provider error. Pi's own `retryProviderRequest` reaches only some provider
 * APIs and only while a stream is being opened, so the budget is spent here
 * instead: every provider gets the same three attempts the previous runtime
 * gave them, and a failure part-way through a stream is retried too.
 */
const MAX_TRANSIENT_MODEL_RETRIES = 3;

/** The first retry's wait; each further attempt doubles it. */
const DEFAULT_RETRY_BASE_DELAY_MS = 500;

/**
 * The one detail an exhausted retry budget reports, so a run that failed after
 * four provider attempts is not read as a run that failed on the first.
 */
const RETRIES_EXHAUSTED_PREFIX = `Retried ${MAX_TRANSIENT_MODEL_RETRIES} times without success`;

/** Executes one fresh in-memory Pi agent and returns only its one submitted result. */
export async function runPatchdeskChild(
  invocation: PatchdeskChildInvocation,
  options: {
    readonly providers?: ReadonlyArray<Provider>;
    readonly skillPath?: string;
    readonly inspectors?: InspectorOperations;
    readonly signal?: AbortSignal;
    readonly onHandle?: (abort: () => Promise<void>) => void;
    readonly onAbortRequested?: () => void;
    /** The transient-retry backoff base, so a test need not wait it out. */
    readonly retryBaseDelayMs?: number;
    /** Where a submission the result schema rejected is kept for diagnosis. */
    readonly rejectedResultPath?: string;
  } = {},
): Promise<PatchdeskChildResult> {
  try {
    assertSupportedNode();
    if (options.signal?.aborted) return { ok: false, reason: "cancelled" };
    const created = await createAgent(invocation, options);
    if (created === undefined)
      return { ok: false, reason: "runtime_unavailable" };
    let built: InsightAgentRun;
    try {
      built = createInsightAgent(
        created.spec,
        options.providers,
        options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
      );
    } catch (cause: unknown) {
      return {
        ok: false,
        reason: "execution_failed",
        ...definedProps({ detail: redactedFailureDetail(cause) }),
      };
    }
    const { agent, turnCapReached, retriesExhausted } = built;
    let abortRequested = false;
    const abort = (): void => {
      if (abortRequested) return;
      abortRequested = true;
      options.onAbortRequested?.();
      agent.abort();
    };
    options.onHandle?.(async () => abort());
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (options.signal?.aborted) {
        abort();
        return { ok: false, reason: "cancelled" };
      }
      // `prompt` settles on a provider failure and on an abort alike: the
      // outcome is read off the agent afterwards, never from a rejection.
      await agent.prompt("Complete the prepared Patchdesk operation.");
      if (abortRequested || options.signal?.aborted)
        return { ok: false, reason: "cancelled" };
      // A recorded result wins: a batch ends only when every call in it
      // terminates, so an inspector ahead of the submission buys one more turn
      // whose provider failure or repeat submission must not discard it.
      const value = created.state.submittedResult();
      if (value !== undefined) {
        const parsed = v.safeParse(resultSchemaFor(invocation.type), value);
        if (parsed.success) return { ok: true, value: parsed.output };
        // The submission arrived as JSON over a tool call, so naming it as such
        // here is what lets the diagnostic write it back out unchanged.
        const raw = v.safeParse(rawJsonValueSchema, value);
        if (raw.success)
          await writeRejectedResult(
            options.rejectedResultPath,
            raw.output,
            parsed.issues,
          );
        return { ok: false, reason: "invalid_result" };
      }
      const failure = runFailureMessage(agent);
      if (failure !== undefined)
        return {
          ok: false,
          reason: "execution_failed",
          ...definedProps({
            detail: redactedFailureDetail(
              retriesExhausted()
                ? `${RETRIES_EXHAUSTED_PREFIX}: ${failure}`
                : failure,
            ),
          }),
        };
      return {
        ok: false,
        reason: "invalid_result",
        ...definedProps({
          detail: turnCapReached() ? TURN_CAP_DETAIL : undefined,
        }),
      };
    } catch (cause: unknown) {
      if (abortRequested || options.signal?.aborted)
        return { ok: false, reason: "cancelled" };
      return {
        ok: false,
        reason: "execution_failed",
        ...definedProps({ detail: redactedFailureDetail(cause) }),
      };
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  } catch (cause: unknown) {
    void cause;
    return { ok: false, reason: "runtime_unavailable" };
  }
}

/**
 * Keeps the raw submission the result schema rejected, with the constraints it
 * broke, beside the prepared debug file. The child otherwise drops the value
 * and an "invalid result" failure cannot be diagnosed after the fact. The write
 * is best-effort: a diagnostic must never turn a failed run into a crash.
 */
export async function writeRejectedResult(
  path: string | undefined,
  value: RawJsonValue,
  issues: ReadonlyArray<v.BaseIssue<unknown>>,
): Promise<void> {
  if (path === undefined) return;
  try {
    const record = JSON.stringify(
      {
        rejectedAt: new Date().toISOString(),
        value,
        issues: issues.map((issue) => ({
          path: v.getDotPath(issue) ?? "",
          message: issue.message,
          expected: issue.expected,
          received: issue.received,
        })),
      },
      undefined,
      2,
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, record, "utf8");
  } catch {
    return;
  }
}

/**
 * The one detail an exhausted turn budget reports, so a run the app's own cap
 * stopped is not read as a malformed model result.
 */
const TURN_CAP_DETAIL = `The model reached the ${MAX_AGENT_TURNS}-turn limit before submitting a result`;

/** One built agent and the budgets it ran against. */
type InsightAgentRun = {
  readonly agent: Agent;
  readonly turnCapReached: () => boolean;
  readonly retriesExhausted: () => boolean;
};

/** Builds the one Pi agent that runs an invocation, with only its own tools mounted. */
function createInsightAgent(
  spec: InsightAgentSpec,
  providers: ReadonlyArray<Provider> | undefined,
  retryBaseDelayMs: number,
): InsightAgentRun {
  const models = createModels();
  for (const provider of providers ?? builtinProviders())
    models.setProvider(provider);
  const model = resolveModel(models, spec.model);
  let turns = 0;
  let exhausted = false;
  const agent = new Agent({
    initialState: {
      systemPrompt: spec.systemPrompt,
      model,
      thinkingLevel: spec.thinkingLevel,
      tools: [...spec.tools],
    },
    streamFn: async (requested, context, streamOptions) => {
      exhausted = false;
      let attempted: AssistantMessageEventStream | undefined;
      await retryAssistantCall(
        async () => {
          // Pi's own client-side retry stays off, so this budget is the only
          // one and a provider that honours `maxRetries` cannot multiply it.
          attempted = models.streamSimple(requested, context, {
            ...streamOptions,
            maxRetries: 0,
          });
          return await attempted.result();
        },
        {
          enabled: true,
          maxRetries: MAX_TRANSIENT_MODEL_RETRIES,
          baseDelayMs: retryBaseDelayMs,
        },
        streamOptions?.signal,
        {
          onRetryFinished: (succeeded, attempt) => {
            exhausted = !succeeded && attempt >= MAX_TRANSIENT_MODEL_RETRIES;
          },
        },
      );
      // Nothing has read the stream while the retry loop awaited its result, so
      // every event of the last attempt is still queued for the agent loop.
      if (attempted === undefined)
        throw new Error("The transient retry loop started no model request");
      return attempted;
    },
    toolExecution: "parallel",
    shouldStopAfterTurn: () => {
      turns += 1;
      return turns >= MAX_AGENT_TURNS;
    },
  });
  return {
    agent,
    turnCapReached: () => turns >= MAX_AGENT_TURNS,
    retriesExhausted: () => exhausted,
  };
}

/** Resolves one `provider-id/model-id` specifier against the registered providers. */
function resolveModel(models: Models, specifier: string): Model<Api> {
  const slash = specifier.indexOf("/");
  const providerId = slash === -1 ? "" : specifier.slice(0, slash);
  const modelId = slash === -1 ? "" : specifier.slice(slash + 1);
  const model =
    providerId === "" || modelId === ""
      ? undefined
      : models.getModel(providerId, modelId);
  if (model === undefined)
    throw new Error(`Unknown Patchdesk model specifier "${specifier}"`);
  return model;
}

/**
 * The provider failure one settled run carries, if any. Pi never rejects
 * `prompt()`: a refused request, an exhausted account, and a rejected model
 * all land on the agent's own error state and on the final assistant message.
 */
function runFailureMessage(agent: Agent): string | undefined {
  if (agent.state.errorMessage !== undefined) return agent.state.errorMessage;
  const last = agent.state.messages.at(-1);
  if (last === undefined || last.role !== "assistant") return undefined;
  if (last.stopReason !== "error" && last.stopReason !== "aborted")
    return undefined;
  return last.errorMessage ?? "The model run failed without a reason";
}

/** The one result schema the child parses each insight's submitted data with. */
function resultSchemaFor(
  type: PatchdeskChildInvocation["type"],
):
  | typeof modelReviewResultSchema
  | typeof walkthroughResultSchema
  | typeof briefResultSchema {
  switch (type) {
    case "analysis":
      return modelReviewResultSchema;
    case "walkthrough":
      return walkthroughResultSchema;
    case "brief":
      return briefResultSchema;
  }
}

async function createAgent(
  invocation: PatchdeskChildInvocation,
  options: {
    readonly skillPath?: string;
    readonly inspectors?: InspectorOperations;
  },
) {
  if (invocation.type === "walkthrough")
    return createWalkthroughAgent(invocation.input);
  if (invocation.type === "brief") return createBriefAgent(invocation.input);
  if (options.skillPath === undefined || options.inspectors === undefined)
    return undefined;
  const skill = await loadPatchdeskReviewSkill(options.skillPath);
  return createAnalysisAgent(invocation.input, options.inspectors, skill);
}

/** Reads exactly one bounded JSON request from stdin and writes one JSON result to stdout. */
export async function runPatchdeskChildProcess(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<void> {
  const raw = await readBoundedStdin(input);
  if (raw === undefined) {
    writeProtocolOutput(output, { ok: false, reason: "invalid_input" });
    return;
  }
  let decoded: RawJsonValue;
  try {
    decoded = JSON.parse(raw);
  } catch {
    writeProtocolOutput(output, { ok: false, reason: "invalid_input" });
    return;
  }
  const invocation = parseProductionInvocation(decoded);
  if (invocation === undefined) {
    writeProtocolOutput(output, { ok: false, reason: "invalid_input" });
    return;
  }
  const controller = new AbortController();
  let abortActive: (() => Promise<void>) | undefined;
  const terminate = (): void => {
    controller.abort();
    void abortActive?.();
  };
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  try {
    const result = await runProductionChild(invocation, controller.signal, {
      onHandle: (abort) => {
        abortActive = abort;
      },
    });
    writeProtocolOutput(output, result);
  } finally {
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGINT", terminate);
  }
}

/** Parses one bounded stdin protocol object sent by the installed app. */
export function parseProductionInvocation(
  input: RawJsonValue,
): ProductionChildInvocation | undefined {
  const parsed = v.safeParse(productionProtocolSchema, input);
  return parsed.success ? parsed.output : undefined;
}

async function readBoundedStdin(
  input: NodeJS.ReadableStream,
): Promise<string | undefined> {
  const chunks: Array<Buffer> = [];
  let bytes = 0;
  for await (const chunk of input) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += next.byteLength;
    if (bytes > MAX_RUNTIME_STDIN_BYTES) return undefined;
    chunks.push(next);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Runs one invocation that arrived over the production protocol: it carries
 * paths and identity only, and the prompt is built here. `providers` and
 * `paths` are in-process seams like `runPatchdeskChild`'s: the stdin protocol
 * can name neither, so a packaged child always uses the built-in provider
 * catalog and the installed app's own directories.
 */
export async function runProductionChild(
  invocation: ProductionChildInvocation,
  signal: AbortSignal,
  options: {
    readonly onHandle: (abort: () => Promise<void>) => void;
    readonly providers?: ReadonlyArray<Provider>;
    readonly paths?: PatchdeskPaths;
  },
): Promise<PatchdeskChildResult> {
  const canonical = canonicalizeProductionInvocation(invocation, options.paths);
  if (canonical === undefined) return { ok: false, reason: "invalid_input" };
  const childOptions = {
    signal,
    onHandle: options.onHandle,
    rejectedResultPath: canonical.rejectedResultPath,
    ...definedProps({ providers: options.providers }),
  };
  if (canonical.type === "walkthrough") {
    const prompt = await prepareWalkthroughPrompt(canonical.input);
    return await runPatchdeskChild(
      { type: "walkthrough", input: { ...canonical.input, prompt } },
      childOptions,
    );
  }
  if (canonical.type === "brief") {
    const prompt = await prepareBriefPrompt(canonical.input);
    return await runPatchdeskChild(
      { type: "brief", input: { ...canonical.input, prompt } },
      childOptions,
    );
  }
  const commands = new CommandRunner();
  let prepared: PreparedModelReview;
  try {
    prepared = await prepareModelReview({
      ...canonical.input,
      debugPath: canonical.debugPath ?? "",
      async gitShow(argv) {
        const output = await commands.runText({
          argv,
          timeoutMs: 15_000,
          signal,
        });
        return output._tag === "ok" ? output.value : "";
      },
    });
  } catch (cause) {
    if (cause instanceof AnalysisPromptTooLargeError)
      return { ok: false, reason: "invalid_input" };
    throw cause;
  }
  return await runPatchdeskChild(
    {
      type: "analysis",
      input: { ...canonical.input, prompt: prepared.prompt },
    },
    {
      ...childOptions,
      skillPath: resolvePatchdeskReviewSkillPath(),
      inspectors: inspectorOperations(prepared.inspector),
    },
  );
}

function resolvePatchdeskReviewSkillPath(): string {
  const runtimeDirectory = dirname(new URL(import.meta.url).pathname);
  const staged = join(
    runtimeDirectory,
    "skills",
    "patchdesk-code-review",
    "SKILL.md",
  );
  if (existsSync(staged)) return staged;
  return join(
    runtimeDirectory,
    "..",
    "..",
    "..",
    "src",
    "skills",
    "patchdesk-code-review",
    "SKILL.md",
  );
}

export { resolvePatchdeskReviewSkillPath };

export function canonicalizeProductionInvocation(
  invocation: ProductionChildInvocation,
  paths: PatchdeskPaths = PatchdeskPaths.default(),
):
  | (ProductionChildInvocation & {
      readonly debugPath?: string;
      readonly rejectedResultPath: string;
    })
  | undefined {
  const profile = parseWorkspaceProfileId(invocation.input.profileId);
  const session = parseReviewSessionId(invocation.input.sessionId);
  if (profile._tag === "err" || session._tag === "err") return undefined;
  if (
    invocation.input.patchPath !== paths.patchFile(profile.value, session.value)
  )
    return undefined;
  // Every insight shares one rejected-submission file, so a Walkthrough or
  // Brief the schema rejected is as diagnosable as an Analysis.
  const rejectedResultPath = paths.rejectedResultFile(
    profile.value,
    session.value,
  );
  // A Brief is built from the patch alone, so it has no prepared context
  // artifact to bind.
  if (invocation.type === "brief") return { ...invocation, rejectedResultPath };
  if (
    invocation.input.contextPath !==
    paths.preparedContextFile(profile.value, session.value)
  )
    return undefined;
  if (invocation.type === "walkthrough")
    return { ...invocation, rejectedResultPath };
  if (
    invocation.input.reviewInputPath !==
      paths.preparedReviewInputFile(profile.value, session.value) ||
    invocation.input.worktreePath !==
      paths.worktreeDirectory(profile.value, session.value)
  )
    return undefined;
  return {
    ...invocation,
    debugPath: paths.preparedDebugFile(profile.value, session.value),
    rejectedResultPath,
  };
}

function inspectorOperations(inspector: ReviewInspector): InspectorOperations {
  return {
    async listChangedFiles() {
      const result = await inspector.listChangedFiles();
      return result._tag === "ok"
        ? { files: [...result.value] }
        : { denied: true };
    },
    async searchFiles(query) {
      const result = await inspector.searchFiles(query);
      return result._tag === "ok"
        ? { files: [...result.value] }
        : { denied: true };
    },
    async readFileRange(path, startLine, endLine) {
      const result = await inspector.readFileRange(path, startLine, endLine);
      return result._tag === "ok"
        ? { content: result.value }
        : { denied: true };
    },
    async gitShow(revision) {
      const result = await inspector.gitShow(revision);
      return result._tag === "ok"
        ? { content: result.value }
        : { denied: true };
    },
  };
}

const MAX_FAILURE_DETAIL_CHARS = 200;

/**
 * Renders one bounded line from a provider failure, given either the agent's
 * own error message or a thrown cause. A thrown cause may wrap the provider's
 * own message ("402: Insufficient Balance") inside a generic error, so the
 * deepest message in the cause chain is the one worth keeping. Credentials
 * never appear in these messages, but a provider is free to echo request
 * material, so any long opaque token-shaped run is replaced before the line
 * leaves the child.
 */
export function redactedFailureDetail(cause: unknown): string | undefined {
  const message = deepestFailureMessage(cause);
  if (message === undefined) return undefined;
  const redacted = message
    .replaceAll(/[\w-]{24,}/g, "[redacted]")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (redacted.length === 0) return undefined;
  return redacted.length > MAX_FAILURE_DETAIL_CHARS
    ? `${redacted.slice(0, MAX_FAILURE_DETAIL_CHARS - 1)}…`
    : redacted;
}

const MAX_FAILURE_CAUSE_DEPTH = 5;
const failureTextSchema = v.pipe(v.string(), v.minLength(1));
const failureCauseSchema = v.looseObject({
  message: v.optional(failureTextSchema),
  cause: v.optional(v.unknown()),
});

function deepestFailureMessage(cause: unknown): string | undefined {
  let current: unknown = cause;
  let deepest: string | undefined;
  for (let depth = 0; depth < MAX_FAILURE_CAUSE_DEPTH; depth += 1) {
    const text = v.safeParse(failureTextSchema, current);
    if (text.success) return text.output;
    const node = v.safeParse(failureCauseSchema, current);
    if (!node.success) return deepest;
    deepest = node.output.message ?? deepest;
    current = node.output.cause;
  }
  return deepest;
}

function writeProtocolOutput(
  output: NodeJS.WritableStream,
  result: PatchdeskChildResult,
): void {
  const encoded = JSON.stringify(result);
  if (
    Buffer.byteLength(encoded, "utf8") > MAX_RUNTIME_STDOUT_BYTES ||
    !isSingleJsonObject(encoded)
  ) {
    output.write(JSON.stringify({ ok: false, reason: "execution_failed" }));
    return;
  }
  output.write(encoded);
}

function isSingleJsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed instanceof Object && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runPatchdeskChildProcess(process.stdin, process.stdout);
}
