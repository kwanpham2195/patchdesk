import { join } from "node:path";

import { providerEnvironmentNames } from "../adapters/pi/pi-provider-catalog";

import type {
  CommandFailure,
  CommandRunner,
} from "../adapters/github/command-runner";
import { parseBriefOutput } from "../domain/brief";
import { definedProps } from "../domain/defined-props";
import { parseAbsolutePath, type AbsolutePath } from "../domain/ids";
import { parseModelReviewResult } from "../domain/review-result";
import { err, ok, type Result } from "../domain/result";
import type { BriefInput } from "./brief-operation";
import {
  ANALYSIS_RUN_TIMEOUT_MS,
  BRIEF_RUN_TIMEOUT_MS,
  invokeWalkthroughWithResolvedTimeout,
} from "./child-invocation";
import type {
  InsightInvocationInput,
  InsightInvoker,
} from "./insight-run-coordinator";
import { readObjectField } from "./read-object-field";
import {
  parseWalkthroughOutput,
  type WalkthroughInput,
  type WalkthroughOutput,
} from "./walkthrough-operation";

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
    | "invalid_result";
  /**
   * The child's bounded, redacted account of why the run failed, forwarded to
   * `InsightRunExecutor` so a provider refusal is recorded as a cause instead
   * of a bare category. Absent whenever the child had nothing to say.
   */
  readonly stderr?: string;
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
  ) {}

  /**
   * Runs one Insight on the built-in runtime.
   *
   * Every precondition Pi alone has is checked here rather than in the
   * composition root, which used to hand-build one object per Insight type and
   * repeat them: this runtime accepts three reasoning efforts of the app-wide
   * five, an analysis needs the prepared review input, and the runner reads
   * whatever paths it is given, so they are parsed before it is spawned. A
   * rejected request is `execution_failed` because the request was wrong, not
   * the model's answer.
   */
  async invoke(
    input: InsightInvocationInput,
    options: { readonly signal: AbortSignal },
  ): Promise<Result<unknown, PiInsightChildFailure>> {
    if (input.provider !== "pi") return err({ reason: "execution_failed" });
    const reasoning = input.reasoning;
    if (reasoning === "minimal" || reasoning === "xhigh")
      return err({ reason: "execution_failed" });
    if (input.type === "walkthrough")
      return invokeWalkthroughWithResolvedTimeout(
        this,
        {
          profileId: input.profileId,
          sessionId: input.sessionId,
          contextPath: input.contextPath,
          patchPath: input.patchPath,
          model: input.model,
          reasoning,
        },
        options,
      );
    if (input.type === "brief") {
      const briefInput: BriefInput = {
        profileId: input.profileId,
        sessionId: input.sessionId,
        patchPath: input.patchPath,
        model: input.model,
        reasoning,
      };
      const brief = await this.runChild(
        { type: "brief", input: briefInput },
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
    };
    const analysis = await this.runChild(
      { type: "analysis", input: analysisInput },
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
   * The walkthrough half of `invoke`, kept a method of its own because it is
   * the `WalkthroughChildInvoker` port: `invokeWalkthroughWithResolvedTimeout`
   * owns resolving the patch-scaled bound under the run's signal, and it can
   * only do that through a seam it calls.
   */
  async invokeWalkthrough(
    input: WalkthroughInput,
    timeoutMs: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<WalkthroughOutput, PiInsightChildFailure>> {
    const result = await this.runChild(
      { type: "walkthrough", input },
      timeoutMs,
      options?.signal,
    );
    if (result._tag === "err") return result;
    const parsed = parseWalkthroughOutput(result.value);
    return parsed._tag === "ok"
      ? ok(parsed.value)
      : err({ reason: "invalid_result" });
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
    const environment = productionChildEnvironment(body);
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
    return err(
      response.detail === undefined
        ? { reason }
        : { reason, stderr: response.detail },
    );
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
    case "invalid_result":
      return "invalid_result";
    default:
      return "execution_failed";
  }
}

function productionChildEnvironment(
  body: unknown,
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
  const environment: Record<string, string> = {};
  environment.ELECTRON_RUN_AS_NODE = "1";
  environment.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
  environment.LANG = "C";
  environment.LC_ALL = "C";
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  const home = process.env.HOME;
  if (
    home !== undefined &&
    (provider === "amazon-bedrock" || provider === "google-vertex")
  )
    environment.HOME = home;
  return environment;
}

function parseChildResponse(input: unknown):
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly detail?: string;
    }
  | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const keys = Object.keys(input);
  const ok = readObjectField(input, "ok");
  if (ok === true && keys.length === 2 && Object.hasOwn(input, "value"))
    return { ok: true, value: readObjectField(input, "value") };
  const reason = readObjectField(input, "reason");
  if (ok === false && typeof reason === "string" && keys.length <= 3) {
    const detail = readObjectField(input, "detail");
    return keys.length === 2
      ? { ok: false, reason }
      : typeof detail === "string"
        ? { ok: false, reason, detail: detail.slice(0, MAX_CHILD_DETAIL_CHARS) }
        : undefined;
  }
  return undefined;
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
    default:
      return "execution_failed";
  }
}
