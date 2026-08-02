import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewScope } from "../domain/review-comparison";
import {
  parseReviewAttemptId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type AbsolutePath,
  type ReviewAttemptId,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import type { ReviewActivityStep } from "./run-projection";
import { readObjectField } from "./read-object-field";

/** The only workflow input Patchdesk admits; all paths come from persisted attempt state. */
export type ReviewWorkflowInput = {
  readonly profileId: WorkspaceProfileId;
  readonly sessionId: ReviewSessionId;
  readonly attemptId?: ReviewAttemptId;
  readonly contextPath: AbsolutePath;
  readonly reviewInputPath: AbsolutePath;
  readonly patchPath: AbsolutePath;
  readonly worktreePath: AbsolutePath;
  readonly scope?: ReviewScope;
  readonly model?: string;
  readonly reasoning?: "low" | "medium" | "high";
};

export type ReviewWorkflowInvoker = {
  /**
   * A provider may expose a durable run ID. Patchdesk never invents one when it
   * does not: the attempt remains Starting until it completes or fails.
   */
  invoke(
    input: ReviewWorkflowInput,
    options?: { readonly signal?: AbortSignal; readonly onActivity?: (step: Exclude<ReviewActivityStep, "complete" | "failed">) => void },
  ): Promise<Result<{ readonly runId?: string }, { readonly reason: "unavailable" | "failed" | "cancelled" }>>;
};

export type ReviewWorkflowStartFailure = {
  readonly reason: "invalid_input" | "not_found" | "not_current" | "unavailable" | "failed" | "cancelled";
};

/** Loads the selected persisted attempt before any Flue interaction can occur. */
export class ReviewWorkflowStarter {
  constructor(
    private readonly sessions: ReviewSessionStore,
    private readonly invoker: ReviewWorkflowInvoker,
  ) {}

  async start(
    input: unknown,
    options?: { readonly signal?: AbortSignal; readonly onActivity?: (step: Exclude<ReviewActivityStep, "complete" | "failed">) => void },
  ): Promise<Result<{ readonly runId?: string }, ReviewWorkflowStartFailure>> {
    const profileId = parseWorkspaceProfileId(readObjectField(input, "profileId"));
    const sessionId = parseReviewSessionId(readObjectField(input, "sessionId"));
    const attemptId = parseReviewAttemptId(readObjectField(input, "attemptId"));
    if (profileId._tag === "err" || sessionId._tag === "err" || attemptId._tag === "err") {
      return err({ reason: "invalid_input" });
    }

    const [session, attempt] = await Promise.all([
      this.sessions.load(profileId.value, sessionId.value),
      this.sessions.loadAttempt(profileId.value, sessionId.value, attemptId.value),
    ]);
    if (session._tag === "err") {
      return err({ reason: session.error.reason === "not_found" ? "not_found" : "failed" });
    }
    if (
      attempt._tag === "err" ||
      session.value.currentAttemptId !== attemptId.value ||
      session.value.state._tag !== "Running" ||
      session.value.state.attemptId !== attemptId.value ||
      (attempt.value.state._tag !== "Starting" && attempt.value.state._tag !== "Running")
    ) {
      return err({ reason: "not_current" });
    }

    const invoked = await this.invoker.invoke({
      profileId: profileId.value,
      sessionId: sessionId.value,
      attemptId: attemptId.value,
      contextPath: attempt.value.contextPath,
      reviewInputPath: attempt.value.reviewInputPath,
      patchPath: session.value.patchPath,
      worktreePath: session.value.worktree.path,
      scope: session.value.scope,
      model: attempt.value.model,
      reasoning: attempt.value.reasoning,
    }, options);
    return invoked._tag === "ok" ? ok(invoked.value) : err({ reason: invoked.error.reason });
  }
}
