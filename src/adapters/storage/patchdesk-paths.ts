import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ReviewAttemptId,
  ReviewId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "../../domain/ids";
import type { InsightType } from "../../domain/insight-record";

export type PatchdeskPathRoots = {
  readonly configDirectory: string;
  readonly dataDirectory: string;
  readonly cacheDirectory: string;
};

/** Builds every app-owned local path without performing filesystem I/O. */
export class PatchdeskPaths {
  private constructor(private readonly roots: PatchdeskPathRoots) {}

  /** Use the standard XDG-style locations for the installed desktop app. */
  static default(): PatchdeskPaths {
    const home = homedir();
    return new PatchdeskPaths({
      configDirectory: join(home, ".config", "patchdesk"),
      dataDirectory: join(home, ".local", "share", "patchdesk"),
      cacheDirectory: join(home, ".cache", "patchdesk"),
    });
  }

  /** Isolate tests beneath one caller-owned temporary directory. */
  static forTest(rootDirectory: string): PatchdeskPaths {
    return new PatchdeskPaths({
      configDirectory: join(rootDirectory, "config", "patchdesk"),
      dataDirectory: join(rootDirectory, "data", "patchdesk"),
      cacheDirectory: join(rootDirectory, "cache", "patchdesk"),
    });
  }

  configDirectory(): string {
    return this.roots.configDirectory;
  }

  dataDirectory(): string {
    return this.roots.dataDirectory;
  }

  cacheDirectory(): string {
    return this.roots.cacheDirectory;
  }

  logsDirectory(): string {
    return join(this.dataDirectory(), "logs");
  }

  /** Active append-only debug log stream; tail -f friendly. */
  logFile(): string {
    return join(this.logsDirectory(), "patchdesk.jsonl");
  }

  configFile(): string {
    return join(this.configDirectory(), "config.json");
  }

  profileFile(profileId: WorkspaceProfileId): string {
    return join(this.configDirectory(), "profiles", `${profileId}.json`);
  }

  dataProfilesDirectory(): string {
    return join(this.dataDirectory(), "profiles");
  }

  sessionDirectory(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(
      this.dataDirectory(),
      "profiles",
      profileId,
      "reviews",
      sessionId,
    );
  }

  profileReviewsDirectory(profileId: WorkspaceProfileId): string {
    return join(this.dataDirectory(), "profiles", profileId, "reviews");
  }

  profileWorkbenchesDirectory(profileId: WorkspaceProfileId): string {
    return join(this.dataDirectory(), "profiles", profileId, "workbenches");
  }

  reviewDirectory(profileId: WorkspaceProfileId, reviewId: ReviewId): string {
    return join(this.profileWorkbenchesDirectory(profileId), reviewId);
  }

  reviewObservationJournalFile(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): string {
    return join(this.reviewDirectory(profileId, reviewId), "observation-journal.json");
  }

  reviewFile(profileId: WorkspaceProfileId, reviewId: ReviewId): string {
    return join(this.reviewDirectory(profileId, reviewId), "review.json");
  }

  insightDirectory(profileId: WorkspaceProfileId, reviewId: ReviewId): string {
    return join(this.reviewDirectory(profileId, reviewId), "insights");
  }

  insightFile(profileId: WorkspaceProfileId, reviewId: ReviewId, type: InsightType): string {
    return join(this.insightDirectory(profileId, reviewId), `${type}.json`);
  }

  publicationAuthorizationFile(profileId: WorkspaceProfileId, reviewId: ReviewId): string {
    return join(this.insightDirectory(profileId, reviewId), "publication.json");
  }

  /** Marker written last after legacy Review artifacts have been adopted. */
  reviewMigrationMarkerFile(profileId: WorkspaceProfileId): string {
    return join(this.dataDirectory(), "profiles", profileId, "review-migration-v1.json");
  }

  /** Marker written last after legacy local batch evidence is discarded. */
  batchDiscardMarkerFile(profileId: WorkspaceProfileId): string {
    return join(this.dataDirectory(), "profiles", profileId, "batch-discard-v1.json");
  }

  sessionFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(this.sessionDirectory(profileId, sessionId), "session.json");
  }

  mergeOperationFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(this.sessionDirectory(profileId, sessionId), "merge-operation.json");
  }

  patchFile(profileId: WorkspaceProfileId, sessionId: ReviewSessionId): string {
    return join(this.sessionDirectory(profileId, sessionId), "patch.diff");
  }

  /** Immutable prepared inputs shared by every attempt for this exact PR head. */
  preparedDirectory(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(this.sessionDirectory(profileId, sessionId), "prepared");
  }

  preparedContextFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(this.preparedDirectory(profileId, sessionId), "context.json");
  }

  preparedReviewInputFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(this.preparedDirectory(profileId, sessionId), "review-input.md");
  }

  preparedDebugFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(this.preparedDirectory(profileId, sessionId), "debug.json");
  }

  comparisonPatchFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(this.sessionDirectory(profileId, sessionId), "comparison.diff");
  }

  comparisonMetadataFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(this.sessionDirectory(profileId, sessionId), "comparison.json");
  }

  previousFindingsFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(this.sessionDirectory(profileId, sessionId), "previous-findings.json");
  }

  findingLifecycleFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(this.sessionDirectory(profileId, sessionId), "finding-lifecycle.json");
  }

  inboxCacheFile(profileId: WorkspaceProfileId): string {
    return join(this.cacheDirectory(), "profiles", profileId, "inbox-v1.json");
  }

  worktreeMetadataFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(this.sessionDirectory(profileId, sessionId), "worktree.json");
  }

  debugTraceFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(this.sessionDirectory(profileId, sessionId), "debug.jsonl");
  }

  attemptDirectory(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    attemptId: ReviewAttemptId,
  ): string {
    return join(
      this.sessionDirectory(profileId, sessionId),
      "attempts",
      attemptId,
    );
  }

  attemptsDirectory(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(this.sessionDirectory(profileId, sessionId), "attempts");
  }

  attemptFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    attemptId: ReviewAttemptId,
  ): string {
    return join(
      this.attemptDirectory(profileId, sessionId, attemptId),
      "attempt.json",
    );
  }

  attemptContextFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    attemptId: ReviewAttemptId,
  ): string {
    return join(
      this.attemptDirectory(profileId, sessionId, attemptId),
      "context.json",
    );
  }

  attemptReviewInputFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    attemptId: ReviewAttemptId,
  ): string {
    return join(
      this.attemptDirectory(profileId, sessionId, attemptId),
      "review-input.md",
    );
  }

  attemptResultFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    attemptId: ReviewAttemptId,
  ): string {
    return join(
      this.attemptDirectory(profileId, sessionId, attemptId),
      "result.json",
    );
  }

  attemptDebugFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    attemptId: ReviewAttemptId,
  ): string {
    return join(
      this.attemptDirectory(profileId, sessionId, attemptId),
      "debug.json",
    );
  }

  worktreeDirectory(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(
      this.cacheDirectory(),
      "profiles",
      profileId,
      "review-worktrees",
      sessionId,
    );
  }

  /**
   * Validated session-quarantine directory. Callers must pre-validate the
   * entry name; this method only joins already-trusted components.
   */
  quarantinedSessionDirectory(
    profileId: WorkspaceProfileId,
    entryName: string,
  ): string {
    return join(
      this.profileReviewsDirectory(profileId),
      ".quarantine",
      entryName,
    );
  }

  /**
   * Validated worktree-quarantine directory. Callers must pre-validate the
   * entry name; this method only joins already-trusted components.
   */
  quarantinedWorktreeDirectory(
    profileId: WorkspaceProfileId,
    entryName: string,
  ): string {
    return join(
      this.worktreeRootDirectory(profileId),
      ".quarantine",
      entryName,
    );
  }

  worktreeRootDirectory(profileId: WorkspaceProfileId): string {
    return join(this.cacheDirectory(), "profiles", profileId, "review-worktrees");
  }
}
