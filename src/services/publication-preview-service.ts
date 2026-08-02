import type { GitHubReader } from "../adapters/github/github-adapter";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { GitHubReviewEvent, ReviewBatch } from "../domain/review-batch";
import type { IsoTimestamp, LocalReviewItemId, RepoRelativePath, ReviewSessionId, WorkspaceProfileId } from "../domain/ids";
import type { ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import { renderReviewBatchBody } from "./review-submission-service";

export type PublicationPreview = {
  readonly reviewId?: string;
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
    private readonly profiles: Pick<ProfileStore, "load">,
    private readonly sessions: Pick<ReviewSessionStore, "load">,
    private readonly github: Pick<GitHubReader, "getPullRequest">,
  ) {}

  async preview(input: { readonly profileId: WorkspaceProfileId; readonly sessionId: ReviewSessionId; readonly expectedRevision: IsoTimestamp; readonly event: GitHubReviewEvent }): Promise<Result<PublicationPreview, PublicationPreviewFailure>> {
    const [profile, session] = await Promise.all([this.profiles.load(input.profileId), this.sessions.load(input.profileId, input.sessionId)]);
    if (profile._tag === "err") return err(profile.error.reason === "not_found" ? "profile_not_found" : "github_read_failed");
    if (session._tag === "err") return err(session.error.reason === "not_found" ? "session_not_found" : "github_read_failed");
    const batch = session.value.batchContent;
    if (batch === undefined || batch.updatedAt !== input.expectedRevision) return err("revision_conflict");
    if (batch.state._tag === "Submitted") return err("invalid_input");
    if (batch.items.some((item) => item._tag === "InlineComment" && item.include && item.postability === "needs_attention")) return err("needs_attention");
    const current = await this.github.getPullRequest({ profile: profile.value, pr: sessionPr(session.value) });
    if (current._tag === "err") return err("github_read_failed");
    if (current.value.headSha !== session.value.key.headSha || session.value.state._tag === "Stale") return err("stale_head");
    return ok(toPreview(session.value, batch, input.event, current.value.headSha));
  }
}

function toPreview(session: ReviewSession, batch: ReviewBatch, event: GitHubReviewEvent, headSha: string): PublicationPreview {
  const inlineComments = batch.items.flatMap((item) => item._tag === "InlineComment" && item.include && item.postability === "postable"
    ? [{ itemId: item.id, path: item.anchor.path, startLine: item.anchor.startLine, line: item.anchor.line, side: item.anchor.side, body: item.body }]
    : []);
  const threadActions: Array<PublicationPreview["threadActions"][number]> = [];
  for (const item of batch.items) {
    if (item._tag === "ThreadReply" && item.include) threadActions.push({ itemId: item.id, action: "reply", body: item.body });
    if (item._tag === "ThreadState" && item.include) threadActions.push({ itemId: item.id, action: item.action });
  }
  return { sessionId: session.id, headSha, draftRevision: batch.updatedAt, event, body: renderReviewBatchBody(batch), inlineComments, threadActions, warnings: inlineComments.length === 0 ? ["no_inline_comments"] : [] };
}

function sessionPr(session: ReviewSession) {
  return { host: session.key.host, owner: session.key.owner, repo: session.key.repo, number: session.key.prNumber };
}
