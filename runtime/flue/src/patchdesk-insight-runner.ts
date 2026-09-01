import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { init } from "@flue/runtime";
import { start } from "@flue/runtime/node";
import type { Provider } from "@earendil-works/pi-ai";
import * as v from "valibot";

import { CommandRunner } from "../../../src/adapters/github/command-runner";
import { PatchdeskPaths } from "../../../src/adapters/storage/patchdesk-paths";
import { definedProps } from "../../../src/domain/defined-props";
import type { RawJsonValue } from "../../../src/domain/json";
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

/** Executes one fresh in-memory Flue runtime and returns only one data-channel result. */
export async function runPatchdeskChild(
  invocation: PatchdeskChildInvocation,
  options: {
    readonly providers?: ReadonlyArray<Provider>;
    readonly skillPath?: string;
    readonly inspectors?: InspectorOperations;
    readonly signal?: AbortSignal;
    readonly onHandle?: (abort: () => Promise<void>) => void;
    readonly onAbortRequested?: () => void;
  } = {},
): Promise<PatchdeskChildResult> {
  try {
    assertSupportedNode();
    if (options.signal?.aborted) return { ok: false, reason: "cancelled" };
    const agent = await createAgent(invocation, options);
    if (agent === undefined)
      return { ok: false, reason: "runtime_unavailable" };
    const flue =
      options.providers === undefined
        ? await start({ agents: [agent.agent] })
        : await start({ agents: [agent.agent], providers: options.providers });
    let abortRequested = false;
    const handle = init(agent.agent, { id: `patchdesk-${invocation.type}` });
    options.onHandle?.(() => handle.abort());
    const abort = (): void => {
      abortRequested = true;
      options.onAbortRequested?.();
      void handle.abort();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (options.signal?.aborted) {
        abort();
        return { ok: false, reason: "cancelled" };
      }
      const receipt = await handle.dispatch(
        "Complete the prepared Patchdesk operation.",
      );
      if (options.signal?.aborted) {
        abort();
        return { ok: false, reason: "cancelled" };
      }
      const reply = await handle.read(receipt);
      if (abortRequested || options.signal?.aborted)
        return { ok: false, reason: "cancelled" };
      const values = reply.data.patchdeskResult;
      if (
        agent.state.duplicateSubmissionAttempted() ||
        values === undefined ||
        values.length !== 1
      ) {
        return { ok: false, reason: "invalid_result" };
      }
      const value = values[0];
      const parsed = v.safeParse(resultSchemaFor(invocation.type), value);
      return parsed.success
        ? { ok: true, value: parsed.output }
        : { ok: false, reason: "invalid_result" };
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
      await boundedStop(flue.stop());
    }
  } catch (cause: unknown) {
    void cause;
    return { ok: false, reason: "runtime_unavailable" };
  }
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
    const prompt = await prepareBriefPrompt({
      ...canonical.input,
      evidence: {
        ...definedProps({ description: canonical.input.evidence.description }),
        commits: canonical.input.evidence.commits,
      },
    });
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

async function boundedStop(stop: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      stop.catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 1_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export { resolvePatchdeskReviewSkillPath };

export function canonicalizeProductionInvocation(
  invocation: ProductionChildInvocation,
  paths: PatchdeskPaths = PatchdeskPaths.default(),
): (ProductionChildInvocation & { readonly debugPath?: string }) | undefined {
  const profile = parseWorkspaceProfileId(invocation.input.profileId);
  const session = parseReviewSessionId(invocation.input.sessionId);
  if (profile._tag === "err" || session._tag === "err") return undefined;
  if (
    invocation.input.patchPath !== paths.patchFile(profile.value, session.value)
  )
    return undefined;
  // A Brief is built from the patch and the invocation's own evidence, so it
  // has no prepared context artifact to bind.
  if (invocation.type === "brief") return invocation;
  if (
    invocation.input.contextPath !==
    paths.preparedContextFile(profile.value, session.value)
  )
    return undefined;
  if (invocation.type === "walkthrough") return invocation;
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
 * Renders one bounded line from a provider failure. The runtime wraps the
 * provider's own message ("402: Insufficient Balance") inside a generic
 * "Agent run failed" error, so the deepest message in the cause chain is the
 * one worth keeping. Credentials never appear in these messages, but a
 * provider is free to echo request material, so any long opaque token-shaped
 * run is replaced before the line leaves the child.
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
