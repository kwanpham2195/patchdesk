import type {
  ContentHash,
  GitSha,
  InsightRunId,
  IsoTimestamp,
  PublicationAuthorizationId,
  ReviewId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "./ids";
import type { GitHubReviewEvent } from "./review-batch";
import { err, ok, type Result } from "./result";

export type AnalysisCompletionAction =
  | { readonly _tag: "SaveAsReviewDraft" }
  | { readonly _tag: "OpenPreviewWhenComplete" }
  | { readonly _tag: "PublishWhenComplete"; readonly event: GitHubReviewEvent; readonly authorizationId: PublicationAuthorizationId };

export type PublicationRevocationReason =
  | "updates_available"
  | "refresh"
  | "revision_changed"
  | "draft_changed"
  | "draft_not_empty"
  | "analysis_failed"
  | "analysis_cancelled"
  | "validation_failed"
  | "needs_attention"
  | "authorization_mismatch";

export type PublicationAuthorization = {
  readonly schemaVersion: 1;
  readonly id: PublicationAuthorizationId;
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly sessionId: ReviewSessionId;
  readonly headSha: GitSha;
  readonly patchHash: ContentHash;
  readonly analysisRunId: InsightRunId;
  readonly expectedDraftRevision: IsoTimestamp;
  readonly event: GitHubReviewEvent;
  readonly createdAt: IsoTimestamp;
  readonly state:
    | { readonly _tag: "Armed" }
    | { readonly _tag: "Revoked"; readonly reason: PublicationRevocationReason }
    | { readonly _tag: "Consumed"; readonly consumedAt: IsoTimestamp };
};

export function createPublicationAuthorization(input: Omit<PublicationAuthorization, "schemaVersion" | "state">): PublicationAuthorization {
  return { ...input, schemaVersion: 1, state: { _tag: "Armed" } };
}

export function revokePublicationAuthorization(
  authorization: PublicationAuthorization,
  reason: PublicationRevocationReason,
): PublicationAuthorization {
  if (authorization.state._tag !== "Armed") return authorization;
  return { ...authorization, state: { _tag: "Revoked", reason } };
}

export function consumePublicationAuthorization(
  authorization: PublicationAuthorization,
  consumedAt: IsoTimestamp,
): Result<PublicationAuthorization, "not_armed"> {
  if (authorization.state._tag !== "Armed") return err("not_armed");
  return ok({ ...authorization, state: { _tag: "Consumed", consumedAt } });
}

export function authorizationMatches(
  authorization: PublicationAuthorization,
  input: Pick<PublicationAuthorization, "profileId" | "reviewId" | "sessionId" | "headSha" | "patchHash" | "analysisRunId" | "expectedDraftRevision" | "event">,
): boolean {
  return authorization.state._tag === "Armed"
    && authorization.profileId === input.profileId
    && authorization.reviewId === input.reviewId
    && authorization.sessionId === input.sessionId
    && authorization.headSha === input.headSha
    && authorization.patchHash === input.patchHash
    && authorization.analysisRunId === input.analysisRunId
    && authorization.expectedDraftRevision === input.expectedDraftRevision
    && authorization.event === input.event;
}
