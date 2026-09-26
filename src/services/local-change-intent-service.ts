import { nullable, strictObject } from "valibot";

import { containsSensitiveData } from "../adapters/storage/json-file";
import type { ReviewStore } from "../adapters/storage/review-store";
import {
  changeIntentSchema,
  parseChangeIntent,
  type ChangeIntent,
  type ChangeIntentView,
} from "../domain/change-intent";
import type { FailureKinds } from "../domain/failure-kind";
import type { IsoTimestamp, ReviewId, WorkspaceProfileId } from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import {
  isLocalReview,
  reviewRequestSchema,
  setChangeIntent,
} from "../domain/review";
import { hashReviewArtifactContent } from "./review-artifact-hash";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";

/** The wire form of `set`'s request; `intent: null` clears the Change intent. */
export const changeIntentRequestSchema = strictObject({
  ...reviewRequestSchema.entries,
  intent: nullable(changeIntentSchema),
});

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

/** An agent's intent is refused when the Review holds a different one (ADR 0052 `review_local`). */
export type AgentIntentFailure =
  | ChangeIntentFailure
  | { readonly reason: "intent_exists" };

/**
 * Checks an agent's intent text before anything is opened, so a refused
 * intent leaves no Review behind: empty or over the byte bound, or holding a
 * credential-shaped value Patchdesk never stores.
 */
export function checkAgentIntentText(
  markdown: string,
): Result<
  void,
  { readonly reason: "invalid_input" | "change_intent_sensitive" }
> {
  if (parseChangeIntent({ kind: "text", markdown })._tag === "err")
    return err({ reason: "invalid_input" });
  return containsSensitiveData(markdown)
    ? err({ reason: "change_intent_sensitive" })
    : ok(undefined);
}

/** How each Change intent refusal is classified (ADR 0052 "Error model"). */
export const changeIntentFailureKinds = {
  intent_exists: "conflict",
  change_intent_sensitive: "invalid",
  not_found: "not_found",
  in_progress: "conflict",
  terminal: "conflict",
  not_applicable: "conflict",
  storage: "unavailable",
} as const satisfies FailureKinds<AgentIntentFailure["reason"]>;

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
    return this.write(request, () => ok(request.intent));
  }

  /**
   * Records a coding agent's text as the Change intent only when the Review
   * has none (ADR 0052 `review_local`): the same text is kept, and a
   * different intent is never replaced, because it is what the maintainer
   * wants checked.
   */
  async recordAgentIntent(request: {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
    readonly markdown: string;
  }): Promise<Result<{ readonly intentKept: boolean }, AgentIntentFailure>> {
    let kept = false;
    const written = await this.write<AgentIntentFailure>(
      {
        ...request,
        intent: { kind: "text", markdown: request.markdown, source: "agent" },
      },
      (current) => {
        if (current === undefined)
          return ok({
            kind: "text",
            markdown: request.markdown,
            source: "agent",
          });
        kept = current.kind === "text" && current.markdown === request.markdown;
        return kept ? ok(current) : err({ reason: "intent_exists" });
      },
    );
    return written._tag === "ok" ? ok({ intentKept: kept }) : written;
  }

  /** `next` decides the intent from the one the Review holds, under the Review coordinator. */
  private async write<Failure extends { readonly reason: string }>(
    request: ChangeIntentRequest,
    next: (
      current: ChangeIntent | undefined,
    ) => Result<ChangeIntent | undefined, Failure>,
  ): Promise<Result<ChangeIntentState, ChangeIntentFailure | Failure>> {
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
      const intent = next(review.changeIntent);
      if (intent._tag === "err") return intent;
      const changed = setChangeIntent(
        review,
        intent.value,
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
      const stored = changed.value.changeIntent;
      return ok({
        changeIntent: stored === undefined ? null : changeIntentView(stored),
      });
    } finally {
      this.dependencies.coordinator.release(key);
    }
  }
}
