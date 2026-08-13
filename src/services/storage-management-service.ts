import { err, ok, type Result } from "../domain/result";
import {
  type IsoTimestamp,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../domain/ids";
import type { ReviewSession } from "../domain/review-session";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewStore } from "../adapters/storage/review-store";
import type { InsightStore } from "../adapters/storage/insight-store";
import type { MergeOperationStore } from "../adapters/storage/merge-operation-store";
import { createReviewId } from "../domain/ids";
import {
  parseQuarantineEntryName,
  type ReviewArtifactStorage,
} from "../adapters/storage/review-artifact-storage";
import type { StorageFailure } from "../adapters/storage/json-file";
import type { GitReadExecutor } from "./review-worktree-service";
import { ReviewLifecycleGate } from "./review-lifecycle-gate";
import { ReviewPreparationJournal } from "./review-preparation-journal";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";

export type TrashMover = { move(path: string): Promise<Result<void, StorageFailure>> };
export type StorageSessionProjection = {
  readonly id: string;
  readonly prLabel: string;
  readonly state: "prepared";
  readonly updatedAt: string;
  readonly canDiscard: boolean;
};
export type StorageOverview = {
  readonly sessions: ReadonlyArray<StorageSessionProjection>;
  readonly quarantined: ReadonlyArray<{ readonly entryName: string; readonly quarantinedAt: string }>;
  readonly cacheBytes: number;
};
export type StorageDiscardInput = { readonly profileId: WorkspaceProfileId; readonly sessionId: ReviewSessionId };
export type StorageDeleteQuarantinedInput = { readonly profileId: WorkspaceProfileId; readonly entryName: string };
export type StorageClearCacheInput = { readonly profileId: WorkspaceProfileId };
export type StorageManagementFailure =
  | { readonly _tag: "ProfileNotFound" }
  | { readonly _tag: "ProfileUnavailable" }
  | { readonly _tag: "StorageUnavailable" }
  | { readonly _tag: "SessionNotFound" }
  | { readonly _tag: "SessionProtected" }
  | { readonly _tag: "InvalidQuarantineEntryName" }
  | { readonly _tag: "TrashUnavailable" };

type Dependencies = {
  readonly profiles: ProfileStore;
  readonly sessions: ReviewSessionStore;
  readonly reviews: Pick<ReviewStore, "load">;
  readonly insights: Pick<InsightStore, "load">;
  readonly mergeOperations: Pick<MergeOperationStore, "load">;
  readonly artifacts: ReviewArtifactStorage;
  readonly paths: PatchdeskPaths;
  readonly trash?: TrashMover;
  readonly git: GitReadExecutor;
  readonly now: () => IsoTimestamp;
  readonly lifecycleGate?: ReviewLifecycleGate;
  readonly diagnostics?: Pick<ReviewDiagnosticService, "record">;
};

/** Manages only non-running immutable session artifacts and quarantined invalid entries. */
export class StorageManagementService {
  private readonly lifecycleGate: ReviewLifecycleGate;
  constructor(private readonly deps: Dependencies) {
    this.lifecycleGate = deps.lifecycleGate ?? new ReviewLifecycleGate();
  }

  async list(profileId: WorkspaceProfileId): Promise<Result<StorageOverview, StorageManagementFailure>> {
    const profile = await this.deps.profiles.load(profileId);
    if (profile._tag === "err") return err(profile.error.reason === "not_found" ? { _tag: "ProfileNotFound" } : { _tag: "ProfileUnavailable" });
    const [sessions, quarantined, cacheBytes] = await Promise.all([
      this.deps.sessions.listSessions(profileId),
      this.deps.artifacts.listQuarantined(profileId),
      this.deps.artifacts.cacheBytes(profileId),
    ]);
    if (sessions._tag === "err" || quarantined._tag === "err" || cacheBytes._tag === "err") return err({ _tag: "StorageUnavailable" });
    const projected: StorageSessionProjection[] = [];
    for (const session of sessions.value) {
      const protectedSession = await this.isProtected(profileId, session);
      if (protectedSession._tag === "err") return protectedSession;
      projected.push(projectSession(session, !protectedSession.value));
    }
    return ok({ sessions: projected, quarantined: quarantined.value, cacheBytes: cacheBytes.value });
  }

  async discard(input: StorageDiscardInput): Promise<Result<undefined, StorageManagementFailure>> {
    const session = await this.deps.sessions.load(input.profileId, input.sessionId);
    if (session._tag === "err") return err(session.error.reason === "not_found" ? { _tag: "SessionNotFound" } : { _tag: "StorageUnavailable" });
    const protectedSession = await this.isProtected(input.profileId, session.value);
    if (protectedSession._tag === "err") return protectedSession;
    if (protectedSession.value) return err({ _tag: "SessionProtected" });
    const removed = await this.deps.artifacts.removeSession(input.profileId, session.value.id);
    return removed._tag === "ok" ? ok(undefined) : err({ _tag: "StorageUnavailable" });
  }

  async deleteQuarantined(input: StorageDeleteQuarantinedInput): Promise<Result<undefined, StorageManagementFailure>> {
    const entry = parseQuarantineEntryName(input.entryName);
    if (entry._tag === "err") return err({ _tag: "InvalidQuarantineEntryName" });
    if (this.deps.trash === undefined) return err({ _tag: "TrashUnavailable" });
    const present = await this.deps.artifacts.hasQuarantinedSession(input.profileId, entry.value);
    if (present._tag === "err") return err({ _tag: "StorageUnavailable" });
    if (!present.value) return err({ _tag: "SessionNotFound" });
    const moved = await this.deps.trash.move(this.deps.paths.quarantinedSessionDirectory(input.profileId, entry.value));
    return moved._tag === "ok" ? ok(undefined) : err({ _tag: "StorageUnavailable" });
  }

  async clearLocalData(profileId: WorkspaceProfileId): Promise<Result<undefined, StorageManagementFailure>> {
    return await this.lifecycleGate.withProfileLock(profileId, async () => {
      const scanned = await this.deps.sessions.scanSessionEntries(profileId);
      if (scanned._tag === "err") return err({ _tag: "StorageUnavailable" });
      for (const invalid of scanned.value.invalidEntries) {
        const quarantined = invalid.sessionId === undefined
          ? await this.deps.artifacts.quarantineInvalidEntry(profileId, invalid.entryName)
          : await this.deps.artifacts.quarantine(profileId, invalid.sessionId);
        if (quarantined._tag === "err") return err({ _tag: "StorageUnavailable" });
      }
      for (const session of scanned.value.sessions) {
        const protectedSession = await this.isProtected(profileId, session);
        if (protectedSession._tag === "err") return protectedSession;
        if (protectedSession.value) continue;
        const removed = await this.deps.artifacts.removeSession(profileId, session.id);
        if (removed._tag === "err") return err({ _tag: "StorageUnavailable" });
      }
      return ok(undefined);
    });
  }

  async clearCache(profileId: WorkspaceProfileId): Promise<Result<undefined, StorageManagementFailure>> {
    return await this.lifecycleGate.withProfileLock(profileId, async () => {
      const children = await this.deps.artifacts.cacheChildren(profileId);
      if (children._tag === "err") return err({ _tag: "StorageUnavailable" });
      const removed = await this.deps.artifacts.removeCacheChildren(profileId, children.value);
      return removed._tag === "ok" ? ok(undefined) : err({ _tag: "StorageUnavailable" });
    });
  }


  private async isProtected(profileId: WorkspaceProfileId, session: ReviewSession): Promise<Result<boolean, StorageManagementFailure>> {
    const preparation = await ReviewPreparationJournal.activeFor(
      this.deps.paths,
      profileId,
      session.id,
      this.deps.diagnostics,
    );
    if (preparation._tag === "err") return err({ _tag: "StorageUnavailable" });
    if (preparation.value !== undefined) return ok(true);
    const reviewId = createReviewId(session.key);
    const [review, analysis, walkthrough, merge] = await Promise.all([
      this.deps.reviews.load(profileId, reviewId),
      this.deps.insights.load(profileId, reviewId, "analysis"),
      this.deps.insights.load(profileId, reviewId, "walkthrough"),
      this.deps.mergeOperations.load(profileId, session.id),
    ]);
    if ([review, analysis, walkthrough, merge].some((value) => value._tag === "err" && value.error.reason !== "not_found")) return err({ _tag: "StorageUnavailable" });
    if (review._tag === "ok" && review.value.currentSessionId === session.id) return ok(true);
    if ((analysis._tag === "ok" && analysis.value.activeRun?.revision.sessionId === session.id) || (walkthrough._tag === "ok" && walkthrough.value.activeRun?.revision.sessionId === session.id)) return ok(true);
    if (session.pendingReview?._tag === "WriteInFlight" || session.pendingReview?._tag === "OutcomeUnknown" || session.directSummaryReview?._tag === "WriteInFlight" || session.directSummaryReview?._tag === "OutcomeUnknown") return ok(true);
    return ok(merge._tag === "ok" && merge.value.state._tag !== "Rejected");
  }
}

function projectSession(session: ReviewSession, canDiscard: boolean): StorageSessionProjection {
  return { id: session.id, prLabel: `${session.key.owner}/${session.key.repo}#${session.key.prNumber}`, state: "prepared", updatedAt: session.updatedAt, canDiscard };
}
