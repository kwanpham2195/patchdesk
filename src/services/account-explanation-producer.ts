import { realpath } from "node:fs/promises";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { CodexAppServerClient } from "#src/adapters/codex/codex-app-server-client";
import type { RepresentedReviewWorktree } from "#src/domain/represented-review-worktree";
import type { WorktreeHeadReader } from "./account-insight-invoker";
import type {
  NativeExplanationProducer,
  ExplanationProducerOutcome,
} from "./explanation-producer";
import { loadInsightEvidenceReference } from "./insight-evidence-reference";
import { composeNativeExplanationPrompt } from "./native-explanation-prompt";

type GuideInput = Parameters<NativeExplanationProducer["invokeGuide"]>[0];
type WalkthroughInput = Parameters<
  NativeExplanationProducer["invokeWalkthroughSession"]
>[0];

/** Resolves only host-owned paths and captured evidence before creating a native connection. */
export class AccountExplanationProducer implements NativeExplanationProducer {
  readonly transport = "native" as const;
  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly executable: () => Promise<string | undefined>,
    private readonly readHead: WorktreeHeadReader,
    private readonly clientFactory: (
      path: string,
    ) => Pick<CodexAppServerClient, "runExplanation"> = (path) =>
      new CodexAppServerClient(path),
  ) {}

  invokeGuide(input: GuideInput): Promise<ExplanationProducerOutcome> {
    return this.invoke({ kind: "guide", input });
  }
  invokeWalkthroughSession(
    input: WalkthroughInput,
  ): Promise<ExplanationProducerOutcome> {
    return this.invoke({ kind: "walkthrough", input });
  }

  private async invoke(
    request:
      | { readonly kind: "guide"; readonly input: GuideInput }
      | { readonly kind: "walkthrough"; readonly input: WalkthroughInput },
  ): Promise<ExplanationProducerOutcome> {
    const input = request.input;
    const failure = (detail: string): ExplanationProducerOutcome => ({
      _tag: "failed",
      reason: "runtime_unavailable",
      detail,
      effectKnown: true,
    });
    if (input.signal.aborted)
      return { _tag: "failed", reason: "cancelled", effectKnown: true };
    const identity = input.evidence.identity;
    if (
      identity.profileId !== input.profileId ||
      identity.sessionId !== input.sessionId ||
      identity.runId.toString() !== input.identity.runId.toString() ||
      identity.type !== request.kind
    )
      return failure("evidence_mismatch");
    const worktree = await realpath(
      this.paths.worktreeDirectory(identity.profileId, identity.sessionId),
    ).catch(() => undefined);
    if (
      worktree === undefined ||
      (await this.readHead(worktree)) !== identity.headSha
    )
      return failure("review_worktree_unavailable");
    const bundle = await loadInsightEvidenceReference(
      input.evidence,
      this.paths,
    );
    if (bundle._tag === "err")
      return {
        _tag: "failed",
        reason:
          bundle.error.reason === "evidence_mismatch"
            ? "evidence_mismatch"
            : "evidence_unavailable",
        effectKnown: true,
      };
    const prompt = await composeNativeExplanationPrompt(
      request.kind,
      bundle.value,
      input.language,
      this.paths,
    );
    if (prompt._tag === "err") return failure(prompt.error);
    const executable = await this.executable();
    if (executable === undefined) return failure("resolve");
    // SAFETY: the path is resolved from the app-owned session and its immutable captured head was checked above.
    const worktreePath = worktree as RepresentedReviewWorktree;
    return this.clientFactory(executable).runExplanation({
      run: {
        worktreePath,
        expectedHeadSha: identity.headSha,
        model: input.model,
        reasoning: input.reasoning,
        prompt: prompt.value,
      },
      binding:
        request.kind === "guide"
          ? { kind: "guide", tool: request.input.tool }
          : { kind: "walkthrough", tool: request.input.tool },
      identity: input.identity,
      lifecycle: input.lifecycle,
      deadline: input.deadline,
      signal: input.signal,
      onActivity: input.onActivity,
    });
  }
}
