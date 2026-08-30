import { readFile, realpath } from "node:fs/promises";

import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import {
  buildCodexAnalysisPrompt,
  buildCodexWalkthroughPrompt,
  MAX_ANALYSIS_CODEX_PROMPT_BYTES,
  MAX_WALKTHROUGH_PROMPT_BYTES,
  type CodexAppServerClient,
} from "../adapters/codex/codex-app-server-client";
import {
  buildCodexBriefPrompt,
  MAX_BRIEF_PROMPT_BYTES,
} from "../adapters/codex/codex-brief-prompt";
import type { RepresentedReviewWorktree } from "../domain/represented-review-worktree";
import type {
  InsightInvocationInput,
  InsightInvoker,
} from "./insight-run-coordinator";
import { err } from "../domain/result";
import { prepareBriefPrompt } from "./brief-operation";
import { composeReviewPrompt } from "./review-rubric";
import { prepareWalkthroughPrompt } from "./walkthrough-operation";
import {
  ANALYSIS_RUN_TIMEOUT_MS,
  BRIEF_RUN_TIMEOUT_MS,
  resolveWalkthroughTimeoutMs,
} from "./child-invocation";

/** Narrow seam for checking the represented worktree's immutable Git head. */
export type WorktreeHeadReader = (
  worktreePath: string,
) => Promise<string | undefined>;

/** Main-process Codex Insight invoker with app-owned worktree validation. */
export class CodexInsightInvoker implements InsightInvoker {
  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly clientFactory: (
      executablePath: string,
    ) => CodexAppServerClient,
    private readonly executablePath: string,
    private readonly readHead: WorktreeHeadReader,
  ) {}

  async invoke(
    input: InsightInvocationInput,
    options: { readonly signal: AbortSignal },
  ) {
    if (input.provider !== "codex-cli-account")
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
      return err({ reason: "runtime_unavailable" as const });
    const head = await this.readHead(candidatePath);
    if (head === undefined || head !== input.expectedHeadSha)
      return err({ reason: "runtime_unavailable" as const });
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
      return err({ reason: "runtime_unavailable" as const });
    const policy =
      "Read only the represented review revision. Patchdesk validates the result and owns all publication decisions.";
    // SAFETY: candidatePath is realpath-checked against this session's app-owned worktree and its immutable expected head above.
    const worktreePath = candidatePath as RepresentedReviewWorktree;
    if (input.type === "walkthrough") {
      const contextPath = resolvedArtifacts[0];
      const patchPath = resolvedArtifacts[2];
      if (contextPath === undefined || patchPath === undefined)
        return err({ reason: "runtime_unavailable" as const });
      let walkthroughPrompt: string;
      try {
        walkthroughPrompt = await prepareWalkthroughPrompt({
          profileId: input.profileId,
          sessionId: input.sessionId,
          contextPath,
          patchPath,
        });
      } catch {
        return err({ reason: "execution_failed" as const });
      }
      const prompt = buildCodexWalkthroughPrompt({ walkthroughPrompt, policy });
      if (prompt._tag === "err")
        return err({ reason: "execution_failed" as const });
      // Match the Flue path: scale the run bound with the patch instead of a flat five minutes.
      const runTimeoutMs = await resolveWalkthroughTimeoutMs(
        { contextPath, patchPath },
        options.signal,
      );
      const result = await this.clientFactory(this.executablePath).run(
        {
          worktreePath,
          expectedHeadSha: head,
          model: input.model,
          reasoning: input.reasoning,
          prompt: prompt.value,
          maxPromptBytes: MAX_WALKTHROUGH_PROMPT_BYTES,
          runTimeoutMs,
        },
        options,
      );
      return result._tag === "ok"
        ? result
        : err({ reason: result.error.reason, phase: result.error.phase });
    }
    if (input.type === "brief") {
      const briefPatchPath = resolvedArtifacts[2];
      if (briefPatchPath === undefined)
        return err({ reason: "runtime_unavailable" as const });
      let briefPrompt: string;
      try {
        briefPrompt = await prepareBriefPrompt({
          profileId: input.profileId,
          sessionId: input.sessionId,
          patchPath: briefPatchPath,
          evidence: input.briefEvidence ?? { commits: [] },
        });
      } catch {
        return err({ reason: "execution_failed" as const });
      }
      const prompt = buildCodexBriefPrompt({ briefPrompt, policy });
      if (prompt._tag === "err")
        return err({ reason: "execution_failed" as const });
      const result = await this.clientFactory(this.executablePath).run(
        {
          worktreePath,
          expectedHeadSha: head,
          model: input.model,
          reasoning: input.reasoning,
          prompt: prompt.value,
          maxPromptBytes: MAX_BRIEF_PROMPT_BYTES,
          runTimeoutMs: BRIEF_RUN_TIMEOUT_MS,
        },
        options,
      );
      return result._tag === "ok"
        ? result
        : err({ reason: result.error.reason, phase: result.error.phase });
    }
    const contextPath = resolvedArtifacts[0];
    const reviewInputPath = resolvedArtifacts[1];
    const patchPath = resolvedArtifacts[2];
    if (
      contextPath === undefined ||
      reviewInputPath === undefined ||
      patchPath === undefined
    )
      return err({ reason: "runtime_unavailable" as const });
    const [context, reviewInput, fullPatch] = await Promise.all([
      readFile(contextPath, "utf8").catch(() => undefined),
      readFile(reviewInputPath, "utf8").catch(() => undefined),
      readFile(patchPath, "utf8").catch(() => undefined),
    ]);
    if (
      context === undefined ||
      reviewInput === undefined ||
      fullPatch === undefined
    )
      return err({ reason: "runtime_unavailable" as const });
    const analysisPrompt = composeReviewPrompt({
      reviewInput,
      context,
      fullPatch,
    });
    const prompt = buildCodexAnalysisPrompt({ analysisPrompt, policy });
    if (prompt._tag === "err")
      return err({ reason: "execution_failed" as const });
    const result = await this.clientFactory(this.executablePath).run(
      {
        worktreePath,
        expectedHeadSha: head,
        model: input.model,
        reasoning: input.reasoning,
        prompt: prompt.value,
        maxPromptBytes: MAX_ANALYSIS_CODEX_PROMPT_BYTES,
        runTimeoutMs: ANALYSIS_RUN_TIMEOUT_MS,
      },
      options,
    );
    return result._tag === "ok"
      ? result
      : err({ reason: result.error.reason, phase: result.error.phase });
  }
}
