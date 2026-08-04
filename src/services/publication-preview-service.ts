import type { GitHubReader } from "../adapters/github/github-adapter";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { GitHubReviewEvent, ReviewBatch } from "../domain/review-batch";
import { parseContentHash, parseGitSha, type IsoTimestamp, type LocalReviewItemId, type RepoRelativePath, type ReviewId, type ReviewSessionId, type WorkspaceProfileId } from "../domain/ids";
import type { ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import { renderReviewBatchBody } from "./review-submission-service";
import type { ReviewWriteGate } from "./review-write-gate";

export type PublicationPreview = {
  readonly reviewId: ReviewId;
  readonly sessionId: ReviewSessionId;
  readonly headSha: string;
  readonly draftRevision: IsoTimestamp;
  readonly event: GitHubReviewEvent;
  readonly body: string;
  readonly inlineComments: ReadonlyArray<{ readonly itemId: LocalReviewItemId; readonly path: RepoRelativePath; readonly startLine: number; readonly line: number; readonly side: "new" | "old"; readonly body: string }>;
  readonly threadActions: ReadonlyArray<{ readonly itemId: LocalReviewItemId; readonly action: "reply" | "resolve" | "reopen"; readonly body?: string }>;
  readonly warnings: ReadonlyArray<"no_inline_comments" | "github_decision_changed">;
};

export type PublicationPreviewFailure = "invalid_input" | "profile_not_found" | "session_not_found" | "revision_conflict" | "stale_head" | "github_read_failed" | "needs_attention";

export class PublicationPreviewService {
  constructor(
    _profiles: Pick<ProfileStore, "load">,
    _sessions: Pick<ReviewSessionStore, "load">,
    private readonly github: Pick<GitHubReader, "getPullRequest">,
    private readonly writeGate?: ReviewWriteGate,
  ) {}

  async preview(input: { readonly profileId: WorkspaceProfileId; readonly reviewId: ReviewId; readonly sessionId: ReviewSessionId; readonly expectedRevision: IsoTimestamp; readonly expectedHeadSha?: string; readonly expectedPatchHash?: string; readonly event: GitHubReviewEvent }): Promise<Result<PublicationPreview, PublicationPreviewFailure>> {
    const expectedHead = input.expectedHeadSha === undefined ? undefined : parseGitSha(input.expectedHeadSha);
    const expectedPatch = input.expectedPatchHash === undefined ? undefined : parseContentHash(input.expectedPatchHash);
    if (this.writeGate === undefined || expectedHead?._tag !== "ok" || expectedPatch?._tag !== "ok") return err("invalid_input");
    const gated = await this.writeGate.requireFresh(input.profileId, input.reviewId, { sessionId: input.sessionId, headSha: expectedHead.value, patchHash: expectedPatch.value, draftRevision: input.expectedRevision });
    if (gated._tag === "err") return err(gated.error.reason === "not_fresh" ? "stale_head" : gated.error.reason === "not_found" ? "session_not_found" : "github_read_failed");
    const profile = gated.value.profile;
    const session = gated.value.session;
    const batch = session.batchContent;
    if (batch === undefined || batch.updatedAt !== input.expectedRevision) return err("revision_conflict");
    if (batch.state._tag === "Submitted") return err("invalid_input");
    // A draft cannot bypass repair by excluding an unsafe item. The anchor is
    // still durable local state and must be resolved before any publication.
    if (batch.items.some((item) => item._tag === "InlineComment" && item.postability === "needs_attention")) return err("needs_attention");
    const current = await this.github.getPullRequest({ profile, pr: sessionPr(session) });
    if (current._tag === "err") return err("github_read_failed");
    if (current.value.headSha !== session.key.headSha || session.state._tag === "Stale") return err("stale_head");
    return ok(toPreview(input.reviewId, session, batch, input.event, current.value.headSha));
  }
}

function toPreview(reviewId: ReviewId, session: ReviewSession, batch: ReviewBatch, event: GitHubReviewEvent, headSha: string): PublicationPreview {
  const inlineComments = batch.items.flatMap((item) => item._tag === "InlineComment" && item.include && item.postability === "postable"
    ? [{ itemId: item.id, path: item.anchor.path, startLine: item.anchor.startLine, line: item.anchor.line, side: item.anchor.side, body: item.body }]
    : []);
  const threadActions: Array<PublicationPreview["threadActions"][number]> = [];
  for (const item of batch.items) {
    if (item._tag === "ThreadReply" && item.include) threadActions.push({ itemId: item.id, action: "reply", body: item.body });
    if (item._tag === "ThreadState" && item.include) threadActions.push({ itemId: item.id, action: item.action });
  }
  return { reviewId, sessionId: session.id, headSha, draftRevision: batch.updatedAt, event, body: renderReviewBatchBody(batch), inlineComments, threadActions, warnings: inlineComments.length === 0 ? ["no_inline_comments"] : [] };
}

function sessionPr(session: ReviewSession) {
  return { host: session.key.host, owner: session.key.owner, repo: session.key.repo, number: session.key.prNumber };
}
