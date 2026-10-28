import { logInsightEvidenceFailure } from "./insight-evidence-diagnostic";
import type { LogEntryInput } from "#src/domain/log-entry";
import { realpath, lstat } from "node:fs/promises";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { NativeSessionAttemptStore } from "#src/adapters/storage/native-session-attempt-store";
import { InsightEvidenceStore } from "#src/adapters/storage/insight-evidence-store";
import { PiRpcClient } from "#src/adapters/pi-cli/pi-rpc-client";
import { runPiExplanation } from "#src/adapters/pi-cli/pi-explanation-session";
import { codexExplanationDeclarations } from "#src/adapters/codex/codex-explanation-tools";
import type { RepresentedReviewWorktree } from "#src/domain/represented-review-worktree";
import type { WorktreeHeadReader } from "./account-insight-invoker";
import type {
  NativeExplanationProducer,
  ExplanationProducerOutcome,
} from "./explanation-producer";
import { loadInsightEvidenceReference } from "./insight-evidence-reference";
import {
  composeNativeExplanationPrompt,
  composePiExplanationPrompt,
} from "./native-explanation-prompt";

/** Guide uses existing evidence, operations and publication without requiring the API runtime. */
export class PiCliExplanationProducer implements NativeExplanationProducer {
  readonly transport = "native" as const;
  constructor(
    private readonly paths: PatchdeskPaths,
    private readonly executable: () => Promise<string | undefined>,
    private readonly readHead: WorktreeHeadReader,
    private readonly launcher: string,
    private readonly helper: string,
    private readonly diagnostic?: (entry: LogEntryInput) => void,
  ) {}

  async invokeGuide(
    input: Parameters<NativeExplanationProducer["invokeGuide"]>[0],
  ): Promise<ExplanationProducerOutcome> {
    return this.invoke({ kind: "guide", input });
  }

  async invokeWalkthroughSession(
    input: Parameters<NativeExplanationProducer["invokeWalkthroughSession"]>[0],
  ): Promise<ExplanationProducerOutcome> {
    return this.invoke({ kind: "walkthrough", input });
  }

  private async invoke(
    request:
      | {
          kind: "guide";
          input: Parameters<NativeExplanationProducer["invokeGuide"]>[0];
        }
      | {
          kind: "walkthrough";
          input: Parameters<
            NativeExplanationProducer["invokeWalkthroughSession"]
          >[0];
        },
  ): Promise<ExplanationProducerOutcome> {
    const input = request.input;
    const fail = (detail: string): ExplanationProducerOutcome => ({
      _tag: "failed",
      reason: "runtime_unavailable",
      detail,
      effectKnown: true,
    });
    if (input.signal.aborted)
      return { _tag: "failed", reason: "cancelled", effectKnown: true };
    const identity = input.evidence.identity;
    if (
      identity.type !== request.kind ||
      identity.profileId !== input.profileId ||
      identity.sessionId !== input.sessionId ||
      identity.runId.toString() !== input.identity.runId.toString()
    ) {
      logInsightEvidenceFailure(
        this.diagnostic,
        input.identity.runId.toString(),
        "identity_mismatch",
      );
      return fail("evidence_mismatch");
    }
    const worktree = await realpath(
      this.paths.worktreeDirectory(identity.profileId, identity.sessionId),
    ).catch(() => undefined);
    if (
      worktree === undefined ||
      (await this.readHead(worktree)) !== identity.headSha
    )
      return fail("review_worktree_unavailable");
    const resources = await Promise.all(
      [this.launcher, this.helper].map(async (path) => {
        const stat = await lstat(path).catch(() => undefined);
        return stat?.isFile() === true && !stat.isSymbolicLink();
      }),
    );
    if (resources.some((available) => !available))
      return fail("pi_helper_unavailable");
    const bundle = await loadInsightEvidenceReference(
      input.evidence,
      this.paths,
      this.diagnostic,
    );
    if (bundle._tag === "err") return fail(bundle.error.reason);
    const base = await composeNativeExplanationPrompt(
      request.kind,
      bundle.value,
      input.language,
      this.paths,
    );
    if (base._tag === "err") return fail(base.error);
    const declarations = codexExplanationDeclarations(request.kind);
    const prompt = composePiExplanationPrompt(
      base.value,
      this.launcher,
      this.helper,
      declarations,
    );
    if (prompt._tag === "err") return fail(prompt.error);
    const executable = await this.executable();
    if (executable === undefined) return fail("resolve");
    const attempt = await NativeSessionAttemptStore.create(
      this.paths,
      input.evidence,
      input.identity,
      input.model,
      input.reasoning,
    );
    if (attempt._tag === "err") return fail("pi_attempt_storage_refused");
    // SAFETY: this app-owned worktree's real path and captured immutable head were checked above.
    const worktreePath = worktree as RepresentedReviewWorktree;
    const outcome = await runPiExplanation({
      request: input,
      binding:
        request.kind === "guide"
          ? { kind: "guide", tool: request.input.tool }
          : { kind: "walkthrough", tool: request.input.tool },
      run: {
        worktreePath,
        model: input.model,
        reasoning: input.reasoning,
        prompt: prompt.value,
      },
      client: new PiRpcClient(executable),
      attempt: attempt.value,
      declarations,
    });
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- the post-invocation evidence check must observe the tree after the session ends.
    const checked = await new InsightEvidenceStore(
      this.paths,
      this.diagnostic,
    ).validate(bundle.value);
    return checked._tag === "err"
      ? {
          _tag: "failed",
          reason:
            checked.error.reason === "invalid_input"
              ? "evidence_mismatch"
              : checked.error.reason,
          effectKnown: true,
        }
      : outcome;
  }
}
