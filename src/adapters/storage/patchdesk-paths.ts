import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ReviewId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "../../domain/ids";
import type { InsightType } from "../../domain/insight-record";
import type {
  LocalPatchView,
  StoredLocalPatchView,
} from "../../domain/local-patch-view";

export type PatchdeskPathRoots = {
  readonly configDirectory: string;
  readonly dataDirectory: string;
  readonly cacheDirectory: string;
};

/** The roots the app passes to a child process so both sides name the same directories. */
const PATCHDESK_ROOTS_ENVIRONMENT = {
  config: "PATCHDESK_CONFIG_DIRECTORY",
  data: "PATCHDESK_DATA_DIRECTORY",
  cache: "PATCHDESK_CACHE_DIRECTORY",
} as const;

/** Set to `1` to run an unpackaged build against the installed app's roots. */
const DEV_SHARED_ENVIRONMENT = "PATCHDESK_DEV_SHARED";

const INSTALLED_MCP_SOCKET = "patchdesk.sock";
const SHARED_DEV_MCP_SOCKET = "patchdesk-dev.sock";

/** Builds every app-owned local path without performing filesystem I/O. */
export class PatchdeskPaths {
  private constructor(
    private readonly roots: PatchdeskPathRoots,
    private readonly mcpSocketName: string,
  ) {}

  /**
   * The roots one app process uses: the installed app's when packaged, the
   * `-dev` roots when not, so `pnpm dev` never touches the installed app's
   * settings or Reviews. `PATCHDESK_DEV_SHARED=1` sends an unpackaged build
   * back to the installed roots, with its own MCP socket so both apps can listen.
   */
  static forBuild(input: {
    readonly packaged: boolean;
    readonly environment: Readonly<Record<string, string | undefined>>;
  }): PatchdeskPaths {
    if (input.packaged) return PatchdeskPaths.installedRoots();
    if (input.environment[DEV_SHARED_ENVIRONMENT] === "1")
      return PatchdeskPaths.installedRoots(SHARED_DEV_MCP_SOCKET);
    return PatchdeskPaths.rootsNamed("patchdesk-dev", INSTALLED_MCP_SOCKET);
  }

  /** The roots a parent app process passed down, else the installed ones. */
  static fromEnvironment(
    environment: Readonly<Record<string, string | undefined>>,
  ): PatchdeskPaths {
    const configDirectory = environment[PATCHDESK_ROOTS_ENVIRONMENT.config];
    const dataDirectory = environment[PATCHDESK_ROOTS_ENVIRONMENT.data];
    const cacheDirectory = environment[PATCHDESK_ROOTS_ENVIRONMENT.cache];
    if (
      configDirectory === undefined ||
      dataDirectory === undefined ||
      cacheDirectory === undefined
    )
      return PatchdeskPaths.installedRoots();
    return new PatchdeskPaths(
      { configDirectory, dataDirectory, cacheDirectory },
      INSTALLED_MCP_SOCKET,
    );
  }

  private static installedRoots(
    mcpSocketName = INSTALLED_MCP_SOCKET,
  ): PatchdeskPaths {
    return PatchdeskPaths.rootsNamed("patchdesk", mcpSocketName);
  }

  /** Standard XDG-style locations under one app directory name. */
  private static rootsNamed(
    appDirectoryName: string,
    mcpSocketName: string,
  ): PatchdeskPaths {
    const home = homedir();
    return new PatchdeskPaths(
      {
        configDirectory: join(home, ".config", appDirectoryName),
        dataDirectory: join(home, ".local", "share", appDirectoryName),
        cacheDirectory: join(home, ".cache", appDirectoryName),
      },
      mcpSocketName,
    );
  }

  /** Isolate tests beneath one caller-owned temporary directory. */
  static forTest(rootDirectory: string): PatchdeskPaths {
    return new PatchdeskPaths(
      {
        configDirectory: join(rootDirectory, "config", "patchdesk"),
        dataDirectory: join(rootDirectory, "data", "patchdesk"),
        cacheDirectory: join(rootDirectory, "cache", "patchdesk"),
      },
      INSTALLED_MCP_SOCKET,
    );
  }

  /** The environment that makes a child process resolve these same roots through `fromEnvironment`. */
  rootsEnvironment() {
    return {
      [PATCHDESK_ROOTS_ENVIRONMENT.config]: this.configDirectory(),
      [PATCHDESK_ROOTS_ENVIRONMENT.data]: this.dataDirectory(),
      [PATCHDESK_ROOTS_ENVIRONMENT.cache]: this.cacheDirectory(),
    };
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

  /** The Homebrew update helper's output, replaced by each update attempt (#800). */
  appUpdateLogFile(): string {
    return join(this.logsDirectory(), "update.log");
  }

  /** The last launched version, the dismissed release, and a pending update attempt (#800). */
  appUpdateStateFile(): string {
    return join(this.configDirectory(), "app-update.json");
  }

  /** The MCP shim's Unix socket (ADR 0052); `PATCHDESK_MCP_SOCKET` overrides it. */
  mcpSocketFile(): string {
    return join(this.dataDirectory(), "mcp", this.mcpSocketName);
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

  /** The pull requests one profile watches, with the snapshot each poll compares against. */
  watchedPullRequestsFile(profileId: WorkspaceProfileId): string {
    return join(
      this.dataDirectory(),
      "profiles",
      profileId,
      "watched-pull-requests.json",
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

  quarantinedReviewDirectory(
    profileId: WorkspaceProfileId,
    entryName: string,
  ): string {
    return join(
      this.profileWorkbenchesDirectory(profileId),
      ".quarantine",
      entryName,
    );
  }

  refreshOperationFile(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): string {
    return join(
      this.reviewDirectory(profileId, reviewId),
      "refresh-operation.json",
    );
  }

  reviewObservationJournalFile(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): string {
    return join(
      this.reviewDirectory(profileId, reviewId),
      "observation-journal.json",
    );
  }

  /**
   * Durable own-write journal: distinct from `reviewObservationJournalFile`,
   * which is the crash-safe candidate->session->review transition record.
   */
  recentWriteJournalFile(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): string {
    return join(
      this.reviewDirectory(profileId, reviewId),
      "recent-writes.json",
    );
  }

  /** Fixed-name sibling an unreadable journal moves to, so at most one copy is kept per Review. */
  recentWriteJournalQuarantineFile(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): string {
    return join(
      this.reviewDirectory(profileId, reviewId),
      "recent-writes.quarantine.json",
    );
  }
  /** One active GitHub-write intent for a Review, retained until recovery proves its outcome. */
  reviewWriteOperationFile(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): string {
    return join(
      this.reviewDirectory(profileId, reviewId),
      "write-operation.json",
    );
  }

  /** The one Apply suggestion write on a local Review, retained until its file hashes settle it (ADR 0050). */
  localApplyOperationFile(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): string {
    return join(
      this.reviewDirectory(profileId, reviewId),
      "local-apply-operation.json",
    );
  }

  reviewFile(profileId: WorkspaceProfileId, reviewId: ReviewId): string {
    return join(this.reviewDirectory(profileId, reviewId), "review.json");
  }

  insightDirectory(profileId: WorkspaceProfileId, reviewId: ReviewId): string {
    return join(this.reviewDirectory(profileId, reviewId), "insights");
  }

  insightFile(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    type: InsightType,
  ): string {
    return join(this.insightDirectory(profileId, reviewId), `${type}.json`);
  }

  sessionFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(this.sessionDirectory(profileId, sessionId), "session.json");
  }

  /**
   * The files the reviewer marked Viewed on one patch view of this session's
   * Diff; Combined, the only view a pull request has, is `viewed-files.json`.
   */
  viewedFilesFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    view: LocalPatchView,
  ): string {
    return join(
      this.sessionDirectory(profileId, sessionId),
      view === "combined" ? "viewed-files.json" : `viewed-files-${view}.json`,
    );
  }

  /** Fixed-name sibling an unreadable viewed-files record moves to, so a session keeps at most one copy per view. */
  viewedFilesQuarantineFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    view: LocalPatchView,
  ): string {
    return join(
      this.sessionDirectory(profileId, sessionId),
      view === "combined"
        ? "viewed-files.quarantine.json"
        : `viewed-files-${view}.quarantine.json`,
    );
  }

  mergeOperationFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(
      this.sessionDirectory(profileId, sessionId),
      "merge-operation.json",
    );
  }

  patchFile(profileId: WorkspaceProfileId, sessionId: ReviewSessionId): string {
    return join(this.sessionDirectory(profileId, sessionId), "patch.diff");
  }

  /** A shared Review session's Committed or Uncommitted patch; Combined is `patchFile`. */
  viewPatchFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    view: StoredLocalPatchView,
  ): string {
    return join(
      this.sessionDirectory(profileId, sessionId),
      `patch-${view}.diff`,
    );
  }

  /** A shared Review session's patch from the session the Review moved from (#604); rewritten on each move onto the session. */
  roundPatchFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(
      this.sessionDirectory(profileId, sessionId),
      "patch-since-last-refresh.diff",
    );
  }

  /** Immutable prepared inputs shared by every Insight for this exact PR head. */
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
    return join(
      this.preparedDirectory(profileId, sessionId),
      "review-input.md",
    );
  }

  preparedDebugFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(this.preparedDirectory(profileId, sessionId), "debug.json");
  }

  /**
   * The last raw Insight submission the result schema rejected. A rejected
   * submission is otherwise dropped in the child, which leaves an "invalid
   * result" failure with nothing to diagnose.
   */
  rejectedResultFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(
      this.preparedDirectory(profileId, sessionId),
      "rejected-result.json",
    );
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

  /** Holds the temporary index copies a Local snapshot is built in; each is removed after its snapshot. */
  localSnapshotScratchDirectory(profileId: WorkspaceProfileId): string {
    return join(
      this.cacheDirectory(),
      "profiles",
      profileId,
      "local-snapshots",
    );
  }

  /** Holds the patch file each Apply hands to `git apply`; each is removed after its write. */
  localApplyScratchDirectory(profileId: WorkspaceProfileId): string {
    return join(this.cacheDirectory(), "profiles", profileId, "local-apply");
  }

  worktreeRootDirectory(profileId: WorkspaceProfileId): string {
    return join(
      this.cacheDirectory(),
      "profiles",
      profileId,
      "review-worktrees",
    );
  }

  /**
   * Shared per-profile avatar byte cache, keyed by a hash of the source
   * avatar URL (see `hashAvatarUrl`). Deliberately alongside the other
   * re-fetchable per-profile caches (`inboxCacheFile`, `worktreeDirectory`)
   * rather than under `dataDirectory`: avatars are re-derivable from GitHub
   * at any time and shared across every review a reviewer appears in, so
   * they belong with cache state, not durable per-review data.
   */
  avatarsDirectory(profileId: WorkspaceProfileId): string {
    return join(this.cacheDirectory(), "profiles", profileId, "avatars");
  }

  avatarFile(profileId: WorkspaceProfileId, avatarHash: string): string {
    return join(this.avatarsDirectory(profileId), `${avatarHash}.bin`);
  }

  /**
   * Shared per-profile cache of the images embedded in pull request bodies
   * and comments, keyed by a hash of the source image URL. Cached rather than
   * stored for the same reason as `avatarsDirectory`: the bytes are always
   * re-fetchable from GitHub, and one image can appear in several reviews.
   */
  pullRequestImagesDirectory(profileId: WorkspaceProfileId): string {
    return join(
      this.cacheDirectory(),
      "profiles",
      profileId,
      "pull-request-images",
    );
  }

  pullRequestImageFile(
    profileId: WorkspaceProfileId,
    imageHash: string,
  ): string {
    return join(this.pullRequestImagesDirectory(profileId), `${imageHash}.bin`);
  }
}
