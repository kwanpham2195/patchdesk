import type { PublicationAuthorizationStore } from "../adapters/storage/publication-authorization-store";
import { authorizationMatches, consumePublicationAuthorization, revokePublicationAuthorization, type PublicationRevocationReason } from "../domain/publication-authorization";
import type { ContentHash, GitSha, InsightRunId, IsoTimestamp, PublicationAuthorizationId, ReviewId, ReviewSessionId, WorkspaceProfileId } from "../domain/ids";
import type { GitHubReviewEvent } from "../domain/review-batch";
import { err, ok, type Result } from "../domain/result";

export type CompletionIdentity = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly sessionId: ReviewSessionId;
  readonly headSha: GitSha;
  readonly patchHash: ContentHash;
  readonly analysisRunId: InsightRunId;
  readonly expectedDraftRevision: IsoTimestamp;
  readonly event: GitHubReviewEvent;
};

export type AnalysisCompletionFailure = "not_found" | "storage_failed" | "authorization_mismatch" | "not_armed";

export class AnalysisCompletionService {
  constructor(private readonly store: Pick<PublicationAuthorizationStore, "load" | "save">) {}

  async revoke(input: { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly authorizationId: PublicationAuthorizationId; readonly reason: PublicationRevocationReason }): Promise<Result<void, AnalysisCompletionFailure>> {
    const loaded = await this.store.load(input.profileId, input.reviewId);
    if (loaded._tag === "err") return loaded.error.reason === "not_found" ? err("not_found") : err("storage_failed");
    if (loaded.value.id !== input.authorizationId) return err("authorization_mismatch");
    const saved = await this.store.save(revokePublicationAuthorization(loaded.value, input.reason));
    return saved._tag === "ok" ? ok(undefined) : err("storage_failed");
  }

  async rebindDraftRevision(input: CompletionIdentity & { readonly authorizationId: PublicationAuthorizationId; readonly nextDraftRevision: IsoTimestamp }): Promise<Result<void, AnalysisCompletionFailure>> {
    const loaded = await this.store.load(input.profileId, input.reviewId);
    if (loaded._tag === "err") return loaded.error.reason === "not_found" ? err("not_found") : err("storage_failed");
    const authorization = loaded.value;
    if (authorization.state._tag !== "Armed") return err("not_armed");
    if (authorization.id !== input.authorizationId || !authorizationMatches(authorization, input)) return err("authorization_mismatch");
    const saved = await this.store.save({ ...authorization, expectedDraftRevision: input.nextDraftRevision });
    return saved._tag === "ok" ? ok(undefined) : err("storage_failed");
  }

  async consumeForPublication(input: { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly sessionId: ReviewSessionId; readonly headSha: GitSha; readonly patchHash?: ContentHash; readonly analysisRunId?: InsightRunId; readonly expectedDraftRevision?: IsoTimestamp; readonly event: GitHubReviewEvent; readonly authorizationId: PublicationAuthorizationId; readonly consumedAt: IsoTimestamp }): Promise<Result<void, AnalysisCompletionFailure>> {
    const loaded = await this.store.load(input.profileId, input.reviewId);
    if (loaded._tag === "err") return loaded.error.reason === "not_found" ? err("not_found") : err("storage_failed");
    const authorization = loaded.value;
    if (authorization.state._tag !== "Armed") return err("not_armed");
    if (authorization.id !== input.authorizationId || !authorizationMatches(authorization, {
      profileId: input.profileId,
      reviewId: input.reviewId,
      sessionId: input.sessionId,
      headSha: input.headSha,
      patchHash: input.patchHash ?? authorization.patchHash,
      analysisRunId: input.analysisRunId ?? authorization.analysisRunId,
      expectedDraftRevision: input.expectedDraftRevision ?? authorization.expectedDraftRevision,
      event: input.event,
    })) return err("authorization_mismatch");
    const consumed = consumePublicationAuthorization(authorization, input.consumedAt);
    if (consumed._tag === "err") return err("not_armed");
    const saved = await this.store.save(consumed.value);
    return saved._tag === "ok" ? ok(undefined) : err("storage_failed");
  }

  async consume(input: CompletionIdentity & { readonly authorizationId: PublicationAuthorizationId; readonly consumedAt: IsoTimestamp }): Promise<Result<void, AnalysisCompletionFailure>> {
    const loaded = await this.store.load(input.profileId, input.reviewId);
    if (loaded._tag === "err") return loaded.error.reason === "not_found" ? err("not_found") : err("storage_failed");
    if (loaded.value.id !== input.authorizationId || !authorizationMatches(loaded.value, input)) return err("authorization_mismatch");
    const consumed = consumePublicationAuthorization(loaded.value, input.consumedAt);
    if (consumed._tag === "err") return err("not_armed");
    const saved = await this.store.save(consumed.value);
    return saved._tag === "ok" ? ok(undefined) : err("storage_failed");
  }
}
