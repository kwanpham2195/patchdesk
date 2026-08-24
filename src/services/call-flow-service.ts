import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { CallFlowOutcome } from "../domain/call-flow";
import { parseReviewSessionId, parseWorkspaceProfileId } from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import type { CallFlowChildInvoker } from "./call-flow-child-invoker";
import { readObjectField } from "./read-object-field";

export type CallFlowFailure = {
  readonly reason: "invalid_input" | "not_found" | "storage";
};

/** Loads one immutable Review session and deduplicates its bounded CallDiff run. */
export class CallFlowService {
  private readonly cached = new Map<string, Promise<CallFlowOutcome>>();

  constructor(
    private readonly sessions: Pick<ReviewSessionStore, "load">,
    private readonly invoker: Pick<CallFlowChildInvoker, "invoke">,
  ) {}

  async load(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this method is the local API boundary parser and validates both ids before use.
    input: unknown,
  ): Promise<Result<CallFlowOutcome, CallFlowFailure>> {
    const profileId = parseWorkspaceProfileId(
      readObjectField(input, "profileId"),
    );
    const sessionId = parseReviewSessionId(readObjectField(input, "sessionId"));
    if (profileId._tag === "err" || sessionId._tag === "err")
      return err({ reason: "invalid_input" });
    const session = await this.sessions.load(profileId.value, sessionId.value);
    if (session._tag === "err")
      return err({
        reason: session.error.reason === "not_found" ? "not_found" : "storage",
      });
    if (session.value.localCheckoutWarning !== undefined)
      return ok({ state: "unavailable", reason: "metadata_only" });
    const key = `${profileId.value}:${sessionId.value}`;
    let pending = this.cached.get(key);
    if (pending === undefined) {
      pending = this.run({
        sessionId: session.value.id,
        worktreePath: session.value.worktree.path,
        baseSha: session.value.key.baseSha,
        headSha: session.value.key.headSha,
      });
      this.cached.set(key, pending);
      while (this.cached.size > 8) {
        const oldest = this.cached.keys().next();
        if (oldest.done) break;
        this.cached.delete(oldest.value);
      }
    }
    const outcome = await pending;
    if (outcome.state === "unavailable" && this.cached.get(key) === pending)
      this.cached.delete(key);
    return ok(outcome);
  }

  private async run(input: Parameters<CallFlowChildInvoker["invoke"]>[0]) {
    const result = await this.invoker.invoke(input);
    return result._tag === "ok"
      ? result.value
      : {
          state: "unavailable" as const,
          reason:
            result.error.reason === "cancelled"
              ? ("cancelled" as const)
              : result.error.reason === "timed_out"
                ? ("timed_out" as const)
                : result.error.reason === "runtime_unavailable"
                  ? ("runtime_unavailable" as const)
                  : ("execution_failed" as const),
        };
  }
}
