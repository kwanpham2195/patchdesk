import type { GitHubReader } from "../adapters/github/github-adapter";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewSession } from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";

export type ReviewHeadVerificationFailure =
  | { readonly reason: "github_read" }
  | { readonly reason: "head_changed" };

/** Rechecks the exact prepared head immediately before model execution. */
export class ReviewHeadVerifier {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly sessions: ReviewSessionStore,
    private readonly github: Pick<GitHubReader, "getPullRequest">,
    private readonly now: () => string,
  ) {}

  async verify(session: ReviewSession): Promise<Result<void, ReviewHeadVerificationFailure>> {
    const profile = await this.profiles.load(session.key.profileId);
    if (profile._tag === "err") return err({ reason: "github_read" });
    const current = await this.github.getPullRequest({
      profile: profile.value,
      pr: { host: session.key.host, owner: session.key.owner, repo: session.key.repo, number: session.key.prNumber },
    });
    if (current._tag === "err") return err({ reason: "github_read" });
    if (current.value.headSha === session.key.headSha) return ok(undefined);
    const persisted = await this.sessions.save({
      ...session,
      state: { _tag: "Stale", reason: "head_changed", currentHeadSha: current.value.headSha },
      updatedAt: this.now() as never,
    });
    return persisted._tag === "err" ? err({ reason: "github_read" }) : err({ reason: "head_changed" });
  }
}
