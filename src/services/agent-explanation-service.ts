import { containsSensitiveData } from "../adapters/storage/json-file";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import {
  parseAgentExplanationText,
  projectAgentExplanation,
  type AgentExplanationEntry,
} from "../domain/agent-explanation";
import { fingerprintPatchAnchor } from "../domain/diff-anchor";
import type { FailureKinds } from "../domain/failure-kind";
import type {
  AgentExplanationId,
  IsoTimestamp,
  RepoRelativePath,
  ReviewId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import { isLocalReview, type Review } from "../domain/review";
import {
  addAgentExplanation,
  dismissAgentExplanation,
} from "../domain/review-agent-explanations";
import type { LocalReviewSource } from "../domain/review-source";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import {
  describeCurrentSession,
  type ReviewSessionDescription,
} from "./review-session-description";

/** The coding agent's `explain_lines` call: lines of the Combined diff of `sessionId`, and its text. */
export type AgentExplanationRequest = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly sessionId: ReviewSessionId;
  readonly anchor: {
    readonly path: RepoRelativePath;
    readonly side: "new" | "old";
    readonly startLine: number;
    readonly line: number;
  };
  readonly text: string;
};

/** Dismiss names the session on screen, as every Local draft write does (#452). */
export type AgentExplanationDismissRequest = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly sessionId: ReviewSessionId;
  readonly explanationId: AgentExplanationId;
};

/** What `explain_lines` answers: the stored explanation's id, how many the Review holds, and the session. */
export type AgentExplanationAdded = ReviewSessionDescription & {
  readonly explanationId: AgentExplanationId;
  readonly explanationCount: number;
};

/** What Dismiss answers: the explanations left, as the workbench lists them. */
export type AgentExplanationList = {
  readonly agentExplanations: ReadonlyArray<AgentExplanationEntry>;
};

export type AgentExplanationFailure = {
  readonly reason:
    | "invalid_input"
    /** The text holds a credential-shaped value, which Patchdesk never stores. */
    | "explanation_sensitive"
    | "in_progress"
    | "not_found"
    | "terminal"
    /** Not a local Review, or Dismiss named a session the Review has moved past. */
    | "not_applicable"
    /** `sessionId` is not the Review's current session. */
    | "stale_session"
    /** The lines are not on one side of one hunk of the session's Combined patch. */
    | "lines_not_in_diff"
    /** The Review already holds `MAX_AGENT_EXPLANATIONS`. */
    | "explanation_limit"
    | "storage";
};

/** How each Agent explanation refusal is classified (ADR 0052 "Error model"). */
export const agentExplanationFailureKinds = {
  invalid_input: "invalid",
  explanation_sensitive: "invalid",
  in_progress: "conflict",
  not_found: "not_found",
  terminal: "conflict",
  not_applicable: "conflict",
  stale_session: "conflict",
  lines_not_in_diff: "conflict",
  explanation_limit: "conflict",
  storage: "unavailable",
} as const satisfies FailureKinds<AgentExplanationFailure["reason"]>;

type AgentExplanationDependencies = {
  readonly reviews: Pick<ReviewStore, "load" | "save">;
  readonly sessions: Pick<ReviewSessionStore, "load">;
  readonly coordinator: Pick<ReviewOperationCoordinator, "acquire" | "release">;
  readonly now: () => IsoTimestamp;
  readonly createExplanationId: () => AgentExplanationId;
};

/**
 * The coding agent's explanations on diff lines of a local Review (#665):
 * `explain_lines` adds one, and the maintainer's Dismiss deletes one. Both
 * write under the Review lock. The text is never logged.
 */
export class AgentExplanationService {
  constructor(private readonly dependencies: AgentExplanationDependencies) {}

  /** Credential-shaped text is refused before the Review lock, as a reply is. */
  explain(
    request: AgentExplanationRequest,
  ): Promise<Result<AgentExplanationAdded, AgentExplanationFailure>> {
    const text = parseAgentExplanationText(request.text);
    if (text._tag === "err" || request.anchor.line < request.anchor.startLine)
      return Promise.resolve(err({ reason: "invalid_input" }));
    if (containsSensitiveData(text.value))
      return Promise.resolve(err({ reason: "explanation_sensitive" }));
    return this.withLocalReview(request, async (review) => {
      if (review.currentSessionId !== request.sessionId)
        return err({ reason: "stale_session" });
      const current = await describeCurrentSession(
        this.dependencies.sessions,
        review,
      );
      if (current._tag === "err" || current.value.patch === undefined)
        return err({ reason: "storage" });
      const anchor = fingerprintPatchAnchor(
        current.value.patch,
        request.anchor,
      );
      if (anchor === undefined) return err({ reason: "lines_not_in_diff" });
      const added = addAgentExplanation(review, {
        explanationId: this.dependencies.createExplanationId(),
        sessionId: review.currentSessionId,
        anchor,
        text: text.value,
        createdAt: this.dependencies.now(),
      });
      if (added._tag === "err")
        return err({
          reason:
            added.error._tag === "ExplanationLimit"
              ? "explanation_limit"
              : "terminal",
        });
      const saved = await this.save(review, added.value.review);
      if (saved._tag === "err") return saved;
      return ok({
        ...current.value.description,
        explanationId: added.value.explanation.explanationId,
        explanationCount: added.value.review.agentExplanations?.length ?? 0,
      });
    });
  }

  /** Dismiss is final: the explanation is deleted and frees a slot. */
  dismiss(
    request: AgentExplanationDismissRequest,
  ): Promise<Result<AgentExplanationList, AgentExplanationFailure>> {
    return this.withLocalReview(request, async (review) => {
      if (review.currentSessionId !== request.sessionId)
        return err({ reason: "not_applicable" });
      const dismissed = dismissAgentExplanation(
        review,
        request.explanationId,
        this.dependencies.now(),
      );
      if (dismissed._tag === "err") return err({ reason: "terminal" });
      const saved = await this.save(review, dismissed.value);
      if (saved._tag === "err") return saved;
      return ok({
        agentExplanations: (dismissed.value.agentExplanations ?? []).map(
          projectAgentExplanation,
        ),
      });
    });
  }

  private async save(
    review: Review<LocalReviewSource>,
    next: Review<LocalReviewSource>,
  ): Promise<Result<undefined, AgentExplanationFailure>> {
    if (next === review) return ok(undefined);
    const saved = await this.dependencies.reviews.save(next, review.updatedAt);
    return saved._tag === "ok" ? ok(undefined) : err({ reason: "storage" });
  }

  /** Runs `change` on the local Review it loaded while holding the Review lock. */
  private async withLocalReview<T>(
    request: {
      readonly profileId: WorkspaceProfileId;
      readonly reviewId: ReviewId;
    },
    change: (
      review: Review<LocalReviewSource>,
    ) => Promise<Result<T, AgentExplanationFailure>>,
  ): Promise<Result<T, AgentExplanationFailure>> {
    const key = `${request.profileId}:${request.reviewId}`;
    if (!this.dependencies.coordinator.acquire(key))
      return err({ reason: "in_progress" });
    try {
      const loaded = await this.dependencies.reviews.load(
        request.profileId,
        request.reviewId,
      );
      if (loaded._tag === "err")
        return err({
          reason: loaded.error.reason === "not_found" ? "not_found" : "storage",
        });
      if (!isLocalReview(loaded.value))
        return err({ reason: "not_applicable" });
      if (loaded.value.status._tag === "Terminal")
        return err({ reason: "terminal" });
      return await change(loaded.value);
    } finally {
      this.dependencies.coordinator.release(key);
    }
  }
}
