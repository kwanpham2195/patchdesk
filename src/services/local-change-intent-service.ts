import { containsSensitiveData } from "../adapters/storage/json-file";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { ChangeIntent, ChangeIntentView } from "../domain/change-intent";
import type { FailureKinds } from "../domain/failure-kind";
import type { IsoTimestamp, ReviewId, WorkspaceProfileId } from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import { isLocalReview, setChangeIntent } from "../domain/review";
import { hashReviewArtifactContent } from "./review-artifact-hash";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";

/** `intent` undefined clears the Change intent. */
export type ChangeIntentRequest = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly intent: ChangeIntent | undefined;
};

export type ChangeIntentFailure = {
  readonly reason:
    | "in_progress"
    | "not_found"
    | "terminal"
    /** A pull request Review, which never holds a Change intent. */
    | "not_applicable"
    /** The text holds a credential-shaped value, which Patchdesk never stores. */
    | "change_intent_sensitive"
    | "storage";
};

/** How each Change intent refusal is classified (ADR 0052 "Error model"). */
export const changeIntentFailureKinds = {
  change_intent_sensitive: "invalid",
  not_found: "not_found",
  in_progress: "conflict",
  terminal: "conflict",
  not_applicable: "conflict",
  storage: "unavailable",
} as const satisfies FailureKinds<ChangeIntentFailure["reason"]>;

/** What the Review holds after the write; `null` when it has no Change intent. */
export type ChangeIntentState = {
  readonly changeIntent: ChangeIntentView | null;
};

/** The workbench's view of a Change intent; text is compared with an Analysis by the sha256 of its Markdown. */
export function changeIntentView(intent: ChangeIntent): ChangeIntentView {
  return {
    intent,
    setting:
      intent.kind === "text"
        ? { kind: "text", sha256: hashReviewArtifactContent(intent.markdown) }
        : { kind: "file", path: intent.path },
  };
}

type ChangeIntentDependencies = {
  readonly reviews: Pick<ReviewStore, "load" | "save">;
  readonly coordinator: Pick<ReviewOperationCoordinator, "acquire" | "release">;
  readonly now: () => IsoTimestamp;
};

/**
 * Sets or clears a local Review's Change intent (#467): a Review record write
 * under the Review coordinator, refused while another operation holds it.
 * Transport-neutral, so the desktop route and an MCP tool share it. A spec
 * file is not read here; the Analysis start reads it from its session.
 */
export class LocalChangeIntentService {
  constructor(private readonly dependencies: ChangeIntentDependencies) {}

  async set(
    request: ChangeIntentRequest,
  ): Promise<Result<ChangeIntentState, ChangeIntentFailure>> {
    if (
      request.intent?.kind === "text" &&
      containsSensitiveData(request.intent.markdown)
    )
      return err({ reason: "change_intent_sensitive" });
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
      const review = loaded.value;
      if (!isLocalReview(review)) return err({ reason: "not_applicable" });
      const changed = setChangeIntent(
        review,
        request.intent,
        this.dependencies.now(),
      );
      if (changed._tag === "err") return err({ reason: "terminal" });
      if (changed.value !== review) {
        const saved = await this.dependencies.reviews.save(
          changed.value,
          review.updatedAt,
        );
        if (saved._tag === "err") return err({ reason: "storage" });
      }
      const intent = changed.value.changeIntent;
      return ok({
        changeIntent: intent === undefined ? null : changeIntentView(intent),
      });
    } finally {
      this.dependencies.coordinator.release(key);
    }
  }
}
