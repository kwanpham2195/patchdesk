import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ReviewAttemptId,
  ReviewSessionId,
  WorkspaceProfileId,
} from "../../domain/ids";

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

  configFile(): string {
    return join(this.configDirectory(), "config.json");
  }

  profileFile(profileId: WorkspaceProfileId): string {
    return join(this.configDirectory(), "profiles", `${profileId}.json`);
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

  sessionFile(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
  ): string {
    return join(this.sessionDirectory(profileId, sessionId), "session.json");
  }

  patchFile(profileId: WorkspaceProfileId, sessionId: ReviewSessionId): string {
    return join(this.sessionDirectory(profileId, sessionId), "patch.diff");
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
}
