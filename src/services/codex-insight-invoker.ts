import { readFile, realpath } from "node:fs/promises";

import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import {
  buildCodexPrompt,
  type CodexAppServerClient,
} from "../adapters/codex/codex-app-server-client";
import type { RepresentedReviewWorktree } from "../domain/represented-review-worktree";
import type {
  InsightInvocationInput,
  InsightInvoker,
} from "./insight-run-coordinator";
import { err } from "../domain/result";

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
    const candidatePath = await realpath(input.worktreePath).catch(
      () => undefined,
    );
    const ownedPath = await realpath(expectedPath).catch(() => undefined);
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
    const reviewInputPath = resolvedArtifacts[1];
    if (reviewInputPath === undefined)
      return err({ reason: "runtime_unavailable" as const });
    const reviewInput = await readFile(reviewInputPath, "utf8").catch(
      () => undefined,
    );
    if (reviewInput === undefined)
      return err({ reason: "runtime_unavailable" as const });
    const prompt = buildCodexPrompt({
      insightType: input.type,
      reviewInput,
      policy:
        "Read only the represented review revision. Patchdesk validates the result and owns all publication decisions.",
    });
    if (prompt._tag === "err")
      return err({ reason: "execution_failed" as const });
    // SAFETY: candidatePath is realpath-checked against this session's app-owned worktree and its immutable expected head above.
    const worktreePath = candidatePath as RepresentedReviewWorktree;
    const result = await this.clientFactory(this.executablePath).run(
      {
        worktreePath,
        expectedHeadSha: head,
        model: input.model,
        reasoning: input.reasoning,
        prompt: prompt.value,
      },
      options,
    );
    return result._tag === "ok" ? result : err({ reason: result.error.reason });
  }
}
