import type { LogEntryInput } from "#src/domain/log-entry";
import {
  insightFailureDiagnostic,
  analysisIncompleteDiagnostic,
  insightEvidenceFailureCategory,
} from "#src/domain/insight-failure-diagnostic";
import { NATIVE_INSIGHT_PROMPT_BYTES } from "#src/adapters/codex/codex-insight-policy";
import { accountInsightEvidenceInstructions } from "./account-insight-evidence";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { insightEvidenceReference } from "./insight-evidence-reference";
import { NativeSessionAttemptStore } from "#src/adapters/storage/native-session-attempt-store";

import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import {
  buildCodexAnalysisPrompt,
  MAX_ANALYSIS_CODEX_PROMPT_BYTES,
  type CodexAppServerFailure,
  type CodexRunInput,
} from "#src/adapters/codex/codex-app-server-client";
import type { PiRpcFailure } from "#src/adapters/pi-cli/pi-rpc-client";
import {
  buildCodexBriefPrompt,
  MAX_BRIEF_PROMPT_BYTES,
} from "#src/adapters/codex/codex-brief-prompt";
import type { AccountInsightProvider } from "#src/domain/insight-provider";
import type { RepresentedReviewWorktree } from "#src/domain/represented-review-worktree";
import type {
  InsightInvocationInput,
  InsightInvocationOptions,
  InsightInvoker,
} from "./insight-run-coordinator";
import { casesHandled, err, ok, type Result } from "#src/domain/result";
import { prepareBriefPrompt, type BriefPromptFailure } from "./brief-operation";
import {
  guideCodexOutputSchema,
  analysisCodexOutputSchema,
  briefCodexOutputSchema,
  parseCodexStrictResult,
  parseCodexAnalysisOutcome,
} from "./codex-output-schema";
import { composeReviewPrompt } from "./review-rubric";
import { parsePiCliAnalysisOutcome } from "./pi-cli-analysis-outcome";
import {
  ANALYSIS_RUN_TIMEOUT_MS,
  BRIEF_RUN_TIMEOUT_MS,
  resolveWalkthroughTimeoutMs,
} from "./child-invocation";

/** Narrow seam for checking the represented worktree's immutable Git head. */
export type WorktreeHeadReader = (
  worktreePath: string,
) => Promise<string | undefined>;

/** Why an account provider's CLI run failed, in either client's vocabulary. */
type AccountRunFailure = CodexAppServerFailure | PiRpcFailure;

/**
 * One strict Insight run on an account provider's CLI. The Codex client sends
 * `outputSchema` on its turn; pi has no schema channel and relies on the
 * contract the prompt carries.
 */
export type AccountInsightRunner = {
  run(
    input: CodexRunInput,
    options: InsightInvocationOptions,
  ): Promise<Result<unknown, AccountRunFailure>>;
};

/** Main-process invoker for an account provider (Codex or pi CLI) with app-owned worktree validation. */
export class AccountInsightInvoker implements InsightInvoker {
  constructor(
    private readonly provider: AccountInsightProvider,
    private readonly paths: PatchdeskPaths,
    private readonly clientFactory: (
      executablePath: string,
    ) => AccountInsightRunner,
    private readonly executablePath: string,
    private readonly readHead: WorktreeHeadReader,
    private readonly diagnostic?: (entry: LogEntryInput) => void,
  ) {}

  async invoke(
    input: InsightInvocationInput,
    options: InsightInvocationOptions,
  ) {
    if (input.type === "walkthrough")
      return err({ reason: "runtime_unavailable" as const });
    if (input.provider !== this.provider)
      return err({ reason: "execution_failed" as const });
    const expectedPath = this.paths.worktreeDirectory(
      input.profileId,
      input.sessionId,
    );
    const [candidatePath, ownedPath] = await Promise.all([
      realpath(input.worktreePath).catch(() => undefined),
      realpath(expectedPath).catch(() => undefined),
    ]);
    if (
      candidatePath === undefined ||
      ownedPath === undefined ||
      candidatePath !== ownedPath
    )
      return err({ reason: "review_worktree_unavailable" as const });
    const head = await this.readHead(candidatePath);
    if (head === undefined || head !== input.expectedHeadSha)
      return err({ reason: "review_worktree_unavailable" as const });
    const ownedArtifacts = [
      [
        input.contextPath,
        this.paths.preparedContextFile(input.profileId, input.sessionId),
      ],
      [
        input.reviewInputPath,
        this.paths.preparedReviewInputFile(input.profileId, input.sessionId),
      ],
      [input.patchPath, this.paths.patchFile(input.profileId, input.sessionId)],
    ] as const;
    const resolvedArtifacts = await Promise.all(
      ownedArtifacts.map(async ([candidate, expected]) => {
        if (candidate === undefined) return undefined;
        const [resolvedCandidate, resolvedExpected] = await Promise.all([
          realpath(candidate).catch(() => undefined),
          realpath(expected).catch(() => undefined),
        ]);
        return resolvedCandidate !== undefined &&
          resolvedCandidate === resolvedExpected
          ? resolvedCandidate
          : undefined;
      }),
    );
    if (resolvedArtifacts.some((path) => path === undefined))
      return err({ reason: "review_worktree_unavailable" as const });
    if (input.evidence === undefined)
      return err({ reason: "execution_failed" as const });
    const nativeInstructions = await accountInsightEvidenceInstructions(
      input.evidence,
      this.paths,
      this.diagnostic,
    );
    if (nativeInstructions._tag === "err")
      return err({
        reason: insightEvidenceFailureCategory(nativeInstructions.error.reason),
        ...insightFailureDiagnostic(
          insightEvidenceFailureCategory(nativeInstructions.error.reason),
          "evidence",
        ),
      });
    const evidence = insightEvidenceReference(input.evidence);
    const runNative = async (
      run: CodexRunInput,
    ): Promise<Result<unknown, AccountRunFailure>> => {
      const prompt = `${run.prompt}\n\n${nativeInstructions.value}`;
      if (Buffer.byteLength(prompt) > NATIVE_INSIGHT_PROMPT_BYTES)
        return Promise.resolve(
          err({
            reason: "invalid_result" as const,
            phase: "turn_start" as const,
          }),
        );
      const attempt = await NativeSessionAttemptStore.create(
        this.paths,
        evidence,
        undefined,
        input.model,
        input.reasoning,
        this.provider,
      );
      if (attempt._tag === "err")
        return err({ reason: "runtime_unavailable", phase: "initialize" });
      try {
        const result = await this.clientFactory(this.executablePath).run(
          {
            ...run,
            prompt,
            attempt: attempt.value,
            diagnostic: this.diagnostic,
            runId: evidence.identity.runId,
            maxPromptBytes: NATIVE_INSIGHT_PROMPT_BYTES,
          },
          options,
        );
        if (result._tag === "err")
          attempt.value.fail(
            attempt.value.record.observed.nativeSessionId === undefined
              ? "preflight"
              : "execution",
            attempt.value.record.observed.nativeSessionId === undefined
              ? "native_preflight"
              : "native_execution",
          );
        return result;
      } catch (cause) {
        attempt.value.fail("execution", "native_execution");
        throw cause;
      } finally {
        await attempt.value.save();
      }
    };
    const policy =
      "Read only the represented review revision. Patchdesk validates the result and owns all publication decisions.";
    // SAFETY: candidatePath is realpath-checked against this session's app-owned worktree and its immutable expected head above.
    const worktreePath = candidatePath as RepresentedReviewWorktree;
    if (input.type === "guide") {
      if (input.evidence.tree !== undefined)
        return err({ reason: "evidence_mismatch" as const });
      if (input.guide === undefined)
        return err({
          reason: "execution_failed" as const,
          phase: "guide_input_missing",
        });
      const runTimeoutMs = await resolveWalkthroughTimeoutMs(
        { contextPath: input.contextPath, patchPath: input.patchPath },
        options.signal,
      );
      const result = await runNative({
        worktreePath,
        expectedHeadSha: head,
        model: input.model,
        reasoning: input.reasoning,
        prompt: input.guide.prompt,
        outputSchema: guideCodexOutputSchema,
        maxPromptBytes: NATIVE_INSIGHT_PROMPT_BYTES,
        runTimeoutMs,
      });
      return result._tag === "ok"
        ? result
        : err({
            reason: result.error.reason,
            ...insightFailureDiagnostic(
              result.error.reason,
              result.error.phase,
              result.error.detail,
            ),
          });
    }
    if (input.type === "brief") {
      const briefPatchPath = resolvedArtifacts[2];
      if (briefPatchPath === undefined)
        return err({ reason: "review_worktree_unavailable" as const });
      const briefPrompt = await prepareBriefPrompt({
        patchPath: briefPatchPath,
        language: input.language,
        evidence,
      });
      if (briefPrompt._tag === "err")
        return err(promptPreparationFailure(briefPrompt.error));
      const prompt = buildCodexBriefPrompt({
        briefPrompt: briefPrompt.value,
        policy,
      });
      if (prompt._tag === "err")
        return err({ reason: "execution_failed" as const });
      const result = await runNative({
        worktreePath,
        expectedHeadSha: head,
        model: input.model,
        reasoning: input.reasoning,
        prompt: prompt.value,
        outputSchema: briefCodexOutputSchema,
        maxPromptBytes: MAX_BRIEF_PROMPT_BYTES,
        runTimeoutMs: BRIEF_RUN_TIMEOUT_MS,
      });
      return strictRunResult(result);
    }
    const contextPath = resolvedArtifacts[0];
    const reviewInputPath = resolvedArtifacts[1];
    const patchPath = resolvedArtifacts[2];
    if (
      contextPath === undefined ||
      reviewInputPath === undefined ||
      patchPath === undefined
    )
      return err({ reason: "review_worktree_unavailable" as const });
    const analysisPrompt = composeReviewPrompt({
      evidence,
      language: input.language,
    });
    const prompt = buildCodexAnalysisPrompt({ analysisPrompt, policy });
    if (prompt._tag === "err")
      return err({ reason: "execution_failed" as const });
    const result = await runNative({
      worktreePath,
      expectedHeadSha: head,
      model: input.model,
      reasoning: input.reasoning,
      prompt: prompt.value,
      outputSchema: analysisCodexOutputSchema,
      maxPromptBytes: MAX_ANALYSIS_CODEX_PROMPT_BYTES,
      runTimeoutMs: ANALYSIS_RUN_TIMEOUT_MS,
      analysisCommandDiagnostic:
        this.provider === "codex-cli-account" &&
        options.onAnalysisCommandFailure !== undefined
          ? {
              entryPath: join(input.evidence.directory, "README.md"),
              onFirstFailure: options.onAnalysisCommandFailure,
            }
          : undefined,
    });
    if (result._tag === "err")
      return err({
        reason: result.error.reason,
        ...insightFailureDiagnostic(
          result.error.reason,
          result.error.phase,
          result.error.detail,
        ),
      });
    const outcome =
      this.provider === "pi-cli-account"
        ? parsePiCliAnalysisOutcome(result.value)
        : parseCodexAnalysisOutcome(result.value);
    if (outcome._tag === "err")
      return err({
        reason: "invalid_result" as const,
        ...insightFailureDiagnostic("invalid_result"),
      });
    return outcome.value.outcome === "complete"
      ? ok(outcome.value.result)
      : err({
          reason: "analysis_incomplete" as const,
          ...analysisIncompleteDiagnostic(outcome.value.incomplete),
        });
  }
}

/** A Brief or Analysis result answers a strict schema, so its `null` fields mean absent. */
function strictRunResult(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the runner returns the turn's parsed JSON unvalidated; parseCodexStrictResult below parses it.
  result: Result<unknown, AccountRunFailure>,
) {
  if (result._tag === "err")
    return err({
      reason: result.error.reason,
      ...insightFailureDiagnostic(
        result.error.reason,
        result.error.phase,
        result.error.detail,
      ),
    });
  const value = parseCodexStrictResult(result.value);
  return value === undefined
    ? err({ reason: "invalid_result" as const, phase: "turn" as const })
    : ok(value);
}

/**
 * Maps a prompt-preparation failure onto the invoker's closed vocabulary. The
 * category stays `execution_failed` for a too-large or unindexable artifact
 * because the model was never asked; `phase` is what carries the actionable
 * reason into the run's diagnostic.
 */
function promptPreparationFailure(failure: BriefPromptFailure) {
  switch (failure.reason) {
    case "patch_too_large":
      return {
        reason: "execution_failed",
        phase: "prompt_artifact_too_large",
      } as const;
    case "patch_unreadable":
      return {
        reason: "review_worktree_unavailable",
        phase: "prompt_artifact_unreadable",
      } as const;
    default:
      return casesHandled(failure);
  }
}
