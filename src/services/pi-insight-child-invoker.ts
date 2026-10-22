import * as v from "valibot";
import {
  insightFailureDiagnostic,
  sanitizedInsightFailureDetail,
} from "#src/domain/insight-failure-diagnostic";
import {
  insightEvidenceReference,
  type InsightEvidenceReference,
} from "./insight-evidence-reference";
import { resolveWalkthroughTimeoutMs } from "./child-invocation";
import { join } from "node:path";

import { providerEnvironmentNames } from "#src/adapters/pi/pi-provider-catalog";
import { runExplanationChild } from "#src/adapters/process/explanation-child-channel";
import { runGuideChild } from "#src/adapters/process/guide-child-channel";
import type {
  ExplanationConnectionIdentity,
  ExplanationFrameIdentity,
} from "#src/domain/explanation-channel";
import { guideChildFrameSchema } from "#src/domain/guide-protocol";
import {
  walkthroughChildFrameSchema,
  type WalkthroughChildFrame,
  type WalkthroughAppOutcome,
} from "#src/domain/walkthrough-protocol";
import type { WalkthroughProducer } from "./walkthrough-producer-pass";
import type {
  GuideAppOutcome,
  GuideChildFrame,
} from "#src/domain/guide-protocol";
import { whenLoginShellEnvironmentImported } from "#src/adapters/process/login-shell-import";

import type {
  CommandFailure,
  CommandRunner,
} from "#src/adapters/github/command-runner";
import { parseBriefOutput } from "#src/domain/brief";
import { definedProps } from "#src/domain/defined-props";
import type { InsightLanguage } from "#src/domain/insight-provider";
import { parseAbsolutePath, type AbsolutePath } from "#src/domain/ids";
import { parseModelReviewResult } from "#src/domain/review-result";
import { casesHandled, err, ok, type Result } from "#src/domain/result";
import type { BriefInput } from "./brief-operation";
import {
  ANALYSIS_RUN_TIMEOUT_MS,
  BRIEF_RUN_TIMEOUT_MS,
} from "./child-invocation";
import type {
  InsightInvocationInput,
  InsightInvocationOptions,
  InsightInvoker,
} from "./insight-run-coordinator";
import { readObjectField } from "./read-object-field";

const MAX_CHILD_STDIN_BYTES = 2 * 1024 * 1024;
/** The child bounds its own detail; this is the app-side backstop. */
const MAX_CHILD_DETAIL_CHARS = 200;

export type PiInsightChildFailure = {
  readonly reason:
    | "cancelled"
    | "authentication_required"
    | "rate_limited"
    | "runtime_unavailable"
    | "timed_out"
    | "execution_failed"
    | "invalid_result"
    | "analysis_incomplete"
    | "evidence_unavailable"
    | "evidence_mismatch";
  /**
   * The child's bounded, redacted account of why the run failed, forwarded to
   * `InsightRunExecutor` so a provider refusal is recorded as a cause instead
   * of a bare category. Absent whenever the child had nothing to say.
   */
  readonly stderr?: string;
  readonly phase?: string;
  readonly code?: string;
  readonly detail?: string;
};

/**
 * The runner's analysis request. Its four paths are branded because
 * `invoke` parses them before the child is spawned: the runner reads whatever
 * it is handed, so an unparsed path would reach a spawned process.
 */
type PiInsightChildAnalysisInput = {
  readonly profileId: string;
  readonly sessionId: string;
  readonly contextPath: AbsolutePath;
  readonly reviewInputPath: AbsolutePath;
  readonly patchPath: AbsolutePath;
  readonly worktreePath: AbsolutePath;
  readonly model: string;
  readonly reasoning: "low" | "medium" | "high";
  readonly language: InsightLanguage;
};

/**
 * The Pi seam when no verified Insight runtime resolved. The composition root
 * has no runner path to give `PiInsightChildInvoker`, and a provider that
 * cannot run is still a provider the dispatch has to name, so it names this.
 */
export const unavailablePiInsightInvoker: InsightInvoker = {
  async invoke() {
    return err({ reason: "runtime_unavailable" as const });
  },
};

/** How a tool-driven Guide child ended. `effectKnown` is false when a recorded request may have reached the provider. */
export type PiGuideChildOutcome =
  | { readonly _tag: "finished" }
  | {
      readonly _tag: "failed";
      readonly reason: PiInsightChildFailure["reason"];
      readonly detail?: string;
      readonly effectKnown: boolean;
    };

/** Runs a bounded app-owned one-shot child with the selected built-in provider's ambient credentials. */
export class PiInsightChildInvoker implements InsightInvoker {
  constructor(
    private readonly commands: CommandRunner,
    private readonly projectRoot: string,
    private readonly runtimeExecutable = process.execPath,
    private readonly runnerPath = join(
      projectRoot,
      "runtime",
      "insight",
      "dist",
      "patchdesk-insight-runner.js",
    ),
    /** Injected so the forwarded-credential allowlist can be tested without mutating the process environment. */
    private readonly environment: (name: string) => string | undefined = (
      name,
    ) => process.env[name],
    /** The app's path roots (`PatchdeskPaths.rootsEnvironment()`), so the child checks request paths against the same directories. */
    private readonly rootsEnvironment: Readonly<Record<string, string>> = {},
  ) {}

  /**
   * Runs one Insight on the built-in Pi runtime. Pi accepts low, medium, or
   * high reasoning. Analysis also requires prepared review input and parsed
   * paths because the runner reads supplied paths. This invoker owns Pi's
   * preconditions instead of repeating them in the composition root. Rejected
   * requests are `execution_failed`, not an invalid model result.
   */
  async invoke(
    input: InsightInvocationInput,
    options: InsightInvocationOptions,
  ): Promise<Result<unknown, PiInsightChildFailure>> {
    if (input.type === "walkthrough")
      return err({ reason: "runtime_unavailable" });
    if (input.provider !== "pi") return err({ reason: "execution_failed" });
    const reasoning = input.reasoning;
    if (reasoning === "minimal" || reasoning === "xhigh")
      return err({ reason: "execution_failed" });
    if (
      input.evidence === undefined ||
      input.evidence.identity.profileId !== input.profileId ||
      input.evidence.identity.reviewId !== input.reviewId ||
      input.evidence.identity.sessionId !== input.sessionId ||
      input.evidence.identity.runId !== input.runId ||
      input.evidence.identity.type !== input.type ||
      input.evidence.identity.headSha !== input.expectedHeadSha
    )
      return err({ reason: "execution_failed" });
    const evidence = insightEvidenceReference(input.evidence);
    if (input.type === "guide") {
      if (input.guide === undefined) return err({ reason: "execution_failed" });
      const timeout = await resolveWalkthroughTimeoutMs(
        { contextPath: input.contextPath, patchPath: input.patchPath },
        options.signal,
      );
      return this.runChild(
        {
          type: "guide",
          input: {
            profileId: input.profileId,
            sessionId: input.sessionId,
            contextPath: input.contextPath,
            patchPath: input.patchPath,
            model: input.model,
            reasoning,
            language: input.language,
            evidence,
          },
        },
        timeout,
        options.signal,
      );
    }
    if (input.type === "brief") {
      const briefInput: BriefInput = {
        profileId: input.profileId,
        sessionId: input.sessionId,
        patchPath: input.patchPath,
        model: input.model,
        reasoning,
        language: input.language,
      };
      const brief = await this.runChild(
        { type: "brief", input: { ...briefInput, evidence } },
        BRIEF_RUN_TIMEOUT_MS,
        options.signal,
      );
      if (brief._tag === "err") return brief;
      const parsed = parseBriefOutput(brief.value);
      return parsed._tag === "ok"
        ? ok(parsed.value)
        : err({ reason: "invalid_result" });
    }
    if (input.reviewInputPath === undefined)
      return err({ reason: "execution_failed" });
    const contextPath = parseAbsolutePath(input.contextPath);
    const reviewInputPath = parseAbsolutePath(input.reviewInputPath);
    const patchPath = parseAbsolutePath(input.patchPath);
    const worktreePath = parseAbsolutePath(input.worktreePath);
    if (
      contextPath._tag === "err" ||
      reviewInputPath._tag === "err" ||
      patchPath._tag === "err" ||
      worktreePath._tag === "err"
    )
      return err({ reason: "execution_failed" });
    const analysisInput: PiInsightChildAnalysisInput = {
      profileId: input.profileId,
      sessionId: input.sessionId,
      contextPath: contextPath.value,
      reviewInputPath: reviewInputPath.value,
      patchPath: patchPath.value,
      worktreePath: worktreePath.value,
      model: input.model,
      reasoning,
      language: input.language,
    };
    const analysis = await this.runChild(
      { type: "analysis", input: { ...analysisInput, evidence } },
      ANALYSIS_RUN_TIMEOUT_MS,
      options.signal,
    );
    if (analysis._tag === "err") return analysis;
    const parsed = parseModelReviewResult(analysis.value);
    return parsed._tag === "ok"
      ? ok(parsed.value)
      : err({ reason: "invalid_result" });
  }

  /**
   * Runs the tool-driven Guide child. Unlike `runChild`, the child keeps a private channel to the app for the whole run;
   * the app answers each frame through `handler`. A child that reported its own failure has known effects; one that was
   * killed, timed out or broke the protocol may have a request in flight, so its effects are unknown.
   */
  async invokeGuide(input: {
    readonly profileId: string;
    readonly sessionId: string;
    readonly model: string;
    readonly reasoning: "low" | "medium" | "high";
    readonly language: InsightLanguage;
    readonly evidence: InsightEvidenceReference;
    readonly identity: ExplanationConnectionIdentity;
    readonly handler: (frame: GuideChildFrame) => Promise<GuideAppOutcome>;
    readonly signal: AbortSignal;
  }): Promise<PiGuideChildOutcome> {
    return this.invokeExplanation<GuideChildFrame, GuideAppOutcome>(
      input,
      "guide_session",
      guideChildFrameSchema,
      { status: "refused", reason: "storage" },
      undefined,
      runGuideChild,
    );
  }

  /** Walkthrough generation uses only the admitted private-channel session. */
  invokeWalkthroughSession(
    input: Parameters<WalkthroughProducer["invokeWalkthroughSession"]>[0],
  ): Promise<PiGuideChildOutcome> {
    return this.invokeExplanation<WalkthroughChildFrame, WalkthroughAppOutcome>(
      input,
      "walkthrough_session",
      walkthroughChildFrameSchema,
      { status: "refused", reason: "storage" },
      input.deadlineAt,
    );
  }

  private async invokeExplanation<
    TFrame extends ExplanationFrameIdentity,
    TOutcome extends object,
  >(
    input: Omit<
      Parameters<PiInsightChildInvoker["invokeGuide"]>[0],
      "handler"
    > & { readonly handler: (frame: TFrame) => Promise<TOutcome> },
    kind: "guide_session" | "walkthrough_session",
    frameSchema: v.GenericSchema<unknown, TFrame>,
    storageFailure: TOutcome,
    deadlineAt?: string,
    transport: typeof runExplanationChild<
      TFrame,
      TOutcome
    > = runExplanationChild,
  ): Promise<PiGuideChildOutcome> {
    const unknown = (
      reason: PiInsightChildFailure["reason"],
    ): PiGuideChildOutcome => ({ _tag: "failed", reason, effectKnown: false });
    if (input.signal.aborted)
      return { _tag: "failed", reason: "cancelled", effectKnown: true };
    const stdin = JSON.stringify({
      type: kind,
      input: {
        profileId: input.profileId,
        sessionId: input.sessionId,
        model: input.model,
        reasoning: input.reasoning,
        language: input.language,
        evidence: input.evidence,
        ...definedProps({ deadlineAt }),
        channel: {
          runId: input.identity.runId,
          generation: input.identity.generation,
          cancelEpoch: input.identity.cancelEpoch,
          connection: input.identity.connection,
        },
      },
    });
    if (Buffer.byteLength(stdin, "utf8") > MAX_CHILD_STDIN_BYTES)
      return { _tag: "failed", reason: "execution_failed", effectKnown: true };
    // Credentials are read from this process's environment, which the login shell may still be filling in (ADR 0038).
    await whenLoginShellEnvironmentImported();
    const environment = productionChildEnvironment(
      JSON.parse(stdin),
      this.environment,
      this.rootsEnvironment,
    );
    if (environment === undefined)
      return {
        _tag: "failed",
        reason: "runtime_unavailable",
        effectKnown: true,
      };
    const exit = await transport({
      executable: this.runtimeExecutable,
      args: [this.runnerPath],
      cwd: this.projectRoot,
      environment,
      stdin,
      signal: input.signal,
      identity: input.identity,
      handler: input.handler,
      frameSchema,
      storageFailure,
    });
    switch (exit._tag) {
      case "Aborted":
        return unknown("cancelled");
      case "Violation":
      case "OutputExceeded":
        return unknown("execution_failed");
      case "Unavailable":
        return {
          _tag: "failed",
          reason: "runtime_unavailable",
          effectKnown: true,
        };
      case "Exited": {
        const response = parseGuideChildStdout(exit.stdout);
        if (response === undefined) return unknown("execution_failed");
        if (response.ok) return { _tag: "finished" };
        return {
          _tag: "failed",
          reason: childResponseReason(response.reason),
          // The child names a possibly sent request or an unconfirmed app outcome; its failure then proves nothing.
          effectKnown: !/request_unconfirmed|outcome_unknown/.test(
            response.detail ?? "",
          ),
          ...definedProps({
            detail:
              response.detail === undefined
                ? undefined
                : sanitizedInsightFailureDetail(response.detail),
          }),
        };
      }
      default:
        return casesHandled(exit);
    }
  }

  private async runChild(
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Result<unknown, PiInsightChildFailure>> {
    if (signal?.aborted) return err({ reason: "cancelled" });
    const stdin = JSON.stringify(body);
    if (Buffer.byteLength(stdin, "utf8") > MAX_CHILD_STDIN_BYTES)
      return err({ reason: "execution_failed" });
    // The child's provider credentials are read out of this process's
    // environment, which the login shell may still be filling in (ADR 0038,
    // amended 2026-09-19).
    await whenLoginShellEnvironmentImported();
    const environment = productionChildEnvironment(
      body,
      this.environment,
      this.rootsEnvironment,
    );
    if (environment === undefined)
      return err({ reason: "runtime_unavailable" });
    const output = await this.commands.runJson({
      argv: [this.runtimeExecutable, this.runnerPath],
      cwd: this.projectRoot,
      stdin,
      timeoutMs,
      environment,
      inheritEnvironment: false,
      ...definedProps({ signal }),
    });
    if (signal?.aborted) return err({ reason: "cancelled" });
    if (output._tag === "err")
      return err({ reason: childFailureReason(output.error) });
    const response = parseChildResponse(output.value);
    if (response === undefined) return err({ reason: "invalid_result" });
    if (response.ok) return ok(response.value);
    const reason = childResponseReason(response.reason);
    return err({
      reason,
      ...insightFailureDiagnostic(
        reason,
        response.code ?? response.phase ?? "child",
      ),
      ...definedProps({
        stderr:
          response.detail === undefined
            ? undefined
            : sanitizedInsightFailureDetail(response.detail),
      }),
    });
  }
}

/**
 * Only the child's own `invalid_result` means the model answered with
 * something this app cannot read. Every other refusal -- a rejected request, a
 * provider that failed the run -- is a run failure, and reporting
 * `invalid_input` as an invalid result blamed the model for a request the app
 * or a stale staged runtime got wrong.
 */
function childResponseReason(reason: string): PiInsightChildFailure["reason"] {
  switch (reason) {
    case "cancelled":
      return "cancelled";
    case "runtime_unavailable":
      return "runtime_unavailable";
    case "analysis_incomplete":
    case "evidence_unavailable":
    case "evidence_mismatch":
    case "invalid_result":
      return reason;
    default:
      return "execution_failed";
  }
}

function productionChildEnvironment(
  body: unknown,
  environment: (name: string) => string | undefined,
  rootsEnvironment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return undefined;
  const input = readObjectField(body, "input");
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const model = readObjectField(input, "model");
  if (typeof model !== "string") return undefined;
  const separator = model.indexOf("/");
  if (separator <= 0) return undefined;
  const provider = model.slice(0, separator).toLowerCase();
  const names = providerEnvironmentNames(provider);
  if (names.length === 0) return undefined;
  const childEnvironment: Record<string, string> = {};
  Object.assign(childEnvironment, rootsEnvironment);
  childEnvironment.ELECTRON_RUN_AS_NODE = "1";
  childEnvironment.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
  childEnvironment.LANG = "C";
  childEnvironment.LC_ALL = "C";
  for (const name of names) {
    const value = environment(name);
    if (value !== undefined) childEnvironment[name] = value;
  }
  const home = environment("HOME");
  if (
    home !== undefined &&
    (provider === "amazon-bedrock" || provider === "google-vertex")
  )
    childEnvironment.HOME = home;
  return childEnvironment;
}

const childFailureSchema = v.strictObject({
  ok: v.literal(false),
  reason: v.string(),
  detail: v.optional(v.pipe(v.string(), v.maxLength(MAX_CHILD_DETAIL_CHARS))),
  phase: v.optional(v.picklist(["submission", "model", "evidence"])),
  code: v.optional(v.picklist(["insufficient_evidence", "unable_to_complete"])),
});

function parseChildResponse(
  input: unknown,
):
  | { readonly ok: true; readonly value: unknown }
  | v.InferOutput<typeof childFailureSchema>
  | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const keys = Object.keys(input);
  if (
    readObjectField(input, "ok") === true &&
    keys.length === 2 &&
    Object.hasOwn(input, "value")
  )
    return { ok: true, value: readObjectField(input, "value") };
  const parsed = v.safeParse(childFailureSchema, input);
  if (!parsed.success) return undefined;
  if (
    parsed.output.reason === "analysis_incomplete" &&
    (parsed.output.code === undefined ||
      parsed.output.detail?.trim().length === 0 ||
      parsed.output.detail === undefined)
  )
    return undefined;
  return parsed.output;
}

function parseGuideChildStdout(
  stdout: string,
):
  | { readonly ok: true }
  | v.InferOutput<typeof childFailureSchema>
  | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      readObjectField(parsed, "ok") === true &&
      readObjectField(readObjectField(parsed, "value"), "finished") === true
    )
      return { ok: true };
    const failure = v.safeParse(childFailureSchema, parsed);
    return failure.success ? failure.output : undefined;
  } catch {
    return undefined;
  }
}

function childFailureReason(
  failure: CommandFailure,
): PiInsightChildFailure["reason"] {
  switch (failure._tag) {
    case "CommandAuthenticationRequired":
      return "authentication_required";
    case "CommandRateLimited":
      return "rate_limited";
    case "CommandNotFound":
    case "CommandRuntimeUnavailable":
    case "CommandUnavailable":
      return "runtime_unavailable";
    case "CommandTimedOut":
      return "timed_out";
    case "CommandForbidden":
    case "CommandUnsupported":
    case "CommandMethodNotAllowed":
    case "CommandUnprocessable":
    case "CommandConflict":
    case "CommandPendingReview":
    case "CommandFailed":
    case "CommandInvalidJson":
    case "CommandOutputExceeded":
      return "execution_failed";
    // An aborted child is a cancellation; `runChild` already reports the run's own abort before this runs.
    case "CommandAborted":
      return "cancelled";
    default:
      return casesHandled(failure);
  }
}
