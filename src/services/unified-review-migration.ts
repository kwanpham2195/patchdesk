import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import { createReview, type Review } from "../domain/review";
import type { ReviewSession } from "../domain/review-session";
import type { WorkspaceProfileId } from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import type { StorageFailure } from "../adapters/storage/json-file";

export type UnifiedReviewMigrationResult = {
  readonly migrated: ReadonlyArray<Review>;
  readonly existing: ReadonlyArray<Review>;
  readonly skipped: number;
};

/** Idempotently adopts valid legacy sessions into one stable Review per pull request. */
export class UnifiedReviewMigration {
  constructor(
    private readonly sessions: Pick<ReviewSessionStore, "listSessions">,
    private readonly reviews: Pick<ReviewStore, "load" | "save">,
  ) {}

  async migrateProfile(profileId: WorkspaceProfileId): Promise<Result<UnifiedReviewMigrationResult, StorageFailure>> {
    const listed = await this.sessions.listSessions(profileId);
    if (listed._tag === "err") return listed;
    const groups = new Map<string, ReviewSession[]>();
    for (const session of listed.value) {
      const key = [session.key.host, session.key.owner, session.key.repo, session.key.prNumber].join("\n");
      const group = groups.get(key) ?? [];
      group.push(session);
      groups.set(key, group);
    }
    const migrated: Review[] = [];
    const existing: Review[] = [];
    let skipped = listed.value.length - [...groups.values()].reduce((total, group) => total + group.length, 0);
    for (const group of groups.values()) {
      const selected = selectSession(group);
      if (selected === undefined) { skipped += group.length; continue; }
      const review = createReview({ identity: { profileId, host: selected.key.host, owner: selected.key.owner, repo: selected.key.repo, prNumber: selected.key.prNumber }, currentSessionId: selected.id, headSha: selected.key.headSha, createdAt: selected.createdAt });
      const loaded = await this.reviews.load(profileId, review.id);
      if (loaded._tag === "ok") { existing.push(loaded.value); continue; }
      if (loaded.error.reason !== "not_found") return loaded;
      const saved = await this.reviews.save(review);
      if (saved._tag === "err") return err(saved.error._tag === "StorageFailure" ? saved.error : { _tag: "StorageFailure", operation: "write", reason: "io" });
      migrated.push(review);
    }
    return ok({ migrated, existing, skipped });
  }
}

function selectSession(sessions: ReadonlyArray<ReviewSession>): ReviewSession | undefined {
  return [...sessions].sort((left, right) => {
    const leftTerminal = left.state._tag === "Merged";
    const rightTerminal = right.state._tag === "Merged";
    if (leftTerminal !== rightTerminal) return leftTerminal ? -1 : 1;
    const updated = right.updatedAt.localeCompare(left.updatedAt);
    return updated !== 0 ? updated : right.id.localeCompare(left.id);
  })[0];
}
