import { dirname } from "node:path";

import {
  createFetchedDiffRefs,
  type GitHubReader,
} from "../adapters/github/github-adapter";
import { writeAtomicFile } from "../adapters/storage/json-file";
import type { ReviewArtifactStorage } from "../adapters/storage/review-artifact-storage";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  createReviewSessionId,
  parseAbsolutePath,
  parseContentHash,
  type ContentHash,
  type GitSha,
  type IsoTimestamp,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../domain/ids";
import type { PullRequestRef } from "../domain/pull-request";
import {
  createReviewSession,
  sameReviewRevision,
  type ReviewRevision,
  type ReviewSession,
} from "../domain/review-session";
import { KeyedMutex } from "../domain/keyed-mutex";
import { sameRepositoryIdentity } from "../domain/repository-identity";
import { err, ok, type Result } from "../domain/result";
import { tokenizeUnifiedPatch } from "../domain/unified-patch";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { ReviewContextService } from "./review-context-service";
import { hashReviewArtifactContent } from "./review-artifact-hash";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";
import type { ReviewLifecycleGate } from "./review-lifecycle-gate";
import { exists, ReviewPreparationJournal } from "./review-preparation-journal";
import type {
  ManagedWorktree,
  MetadataOnlyReview,
  ReviewWorktreeService,
  WorktreeFailure,
} from "./review-worktree-service";

/** A refined command to prepare one complete immutable Review session. */
export type PrepareReviewSessionInput = {
  readonly profileId: WorkspaceProfileId;
  readonly pullRequest: PullRequestRef;
  /** Terminal-only opening rechecks that every revision read remains non-open. */
  readonly expectedPullRequestState?: "non_open";
};

export type PreparedReviewSession = {
  readonly session: ReviewSession;
  readonly disposition: "resumed" | "prepared";
};

export type PrepareReviewSessionFailure =
  | { readonly _tag: "ProfileNotFound" }
  | { readonly _tag: "ProfileUnavailable" }
  | { readonly _tag: "GitHubReadUnavailable" }
  | { readonly _tag: "HeadChanged" }
  | { readonly _tag: "PullRequestStateChanged" }
  | { readonly _tag: "SessionStorageUnavailable" }
  | { readonly _tag: "PreparationUnavailable" }
  | { readonly _tag: "PreparationCleanupUnavailable" }
  // A GitHub-authenticated read has already succeeded by this point, so a
  // credential or `gh` failure while preparing the local checkout is a real
  // authentication problem, not a reason to fall back silently.
  | { readonly _tag: "GitHubAuthenticationFailed" };

/**
 * A worktree-mode session may store the local git rendering of the patch on
 * disk for display and insights; that rendering is not what proves revision
 * identity. See ADR 0026 — the canonical hash always comes from GitHub's
 * compare rendering instead.
 */
export function normalizeReviewPatch(patch: string): string {
  return patch;
}

/** Mutable draft of `ReviewWorktreeService.prepare`'s input, built in
 * statements so `localPath` is added only when present. */
type MutableWorktreePrepareInput = {
  -readonly [
    K in keyof Parameters<ReviewWorktreeService["prepare"]>[0]
  ]: Parameters<ReviewWorktreeService["prepare"]>[0][K];
};

/** Mutable draft of a session's `prContext`, built in statements so
 * `description` is added only when present. */
type MutablePrContext = {
  -readonly [K in keyof NonNullable<ReviewSession["prContext"]>]: NonNullable<
    ReviewSession["prContext"]
  >[K];
};

/** Mutable draft of `createReviewSession`'s input, built in statements so
 * `canonicalPatchHash` is added only when present. */
type MutableCreateReviewSessionInput = {
  -readonly [K in keyof Parameters<typeof createReviewSession>[0]]: Parameters<
    typeof createReviewSession
  >[0][K];
};

/** Outcome of writing a session's on-disk artifacts: the canonical patch
 * hash, present only when it could be established. */
type WriteArtifactsResult = { readonly canonicalPatchHash?: ContentHash };

/** Mutable draft of `WriteArtifactsResult`, built in statements so
 * `canonicalPatchHash` is added only when present. */
type MutableWriteArtifactsResult = {
  -readonly [K in keyof WriteArtifactsResult]: WriteArtifactsResult[K];
};

type PreparationDependencies = {
  readonly profiles: ProfileStore;
  readonly sessions: ReviewSessionStore;
  readonly github: Pick<
    GitHubReader,
    | "getPullRequest"
    | "getPullRequestComments"
    | "getPullRequestChecks"
    | "getPullRequestDiff"
  >;
  readonly paths: PatchdeskPaths;
  readonly now: () => IsoTimestamp;
  readonly worktrees: ReviewWorktreeService;
  readonly context: ReviewContextService;
  readonly artifacts: ReviewArtifactStorage;
  readonly lifecycleGate?: ReviewLifecycleGate;
  readonly diagnostics?: Pick<ReviewDiagnosticService, "record">;
};

/** Prepares one full revision and never adopts prior local draft or comparison state. */
export class ReviewSessionPreparation {
  private readonly locks = new KeyedMutex();

  constructor(private readonly dependencies: PreparationDependencies) {}

  async prepare(
    input: PrepareReviewSessionInput,
  ): Promise<Result<PreparedReviewSession, PrepareReviewSessionFailure>> {
    const profile = await this.dependencies.profiles.load(input.profileId);
    if (profile._tag === "err")
      return err({
        _tag:
          profile.error.reason === "not_found"
            ? "ProfileNotFound"
            : "ProfileUnavailable",
      });
    const current = await this.dependencies.github.getPullRequest({
      profile: profile.value,
      pr: input.pullRequest,
    });
    if (current._tag === "err") return err({ _tag: "GitHubReadUnavailable" });
    if (input.expectedPullRequestState === "non_open" && current.value.isOpen)
      return err({ _tag: "PullRequestStateChanged" });
    const revision = reviewRevisionOf(current.value);
    if (revision === undefined) return err({ _tag: "PreparationUnavailable" });
    const sessionId = createReviewSessionId({
      profileId: input.profileId,
      host: input.pullRequest.host,
      owner: input.pullRequest.owner,
      repo: input.pullRequest.repo,
      prNumber: input.pullRequest.number,
      ...revision,
    });
    const run = (): Promise<
      Result<PreparedReviewSession, PrepareReviewSessionFailure>
    > =>
      this.serialized(
        input.profileId,
        sessionId,
        async () =>
          await this.prepareCurrent(input, profile.value, revision, sessionId),
      );
    return this.dependencies.lifecycleGate === undefined
      ? await run()
      : await this.dependencies.lifecycleGate.withProfileLock(
          input.profileId,
          run,
        );
  }

  private async prepareCurrent(
    input: PrepareReviewSessionInput,
    profile: WorkspaceProfileConfig,
    revision: ReviewRevision,
    sessionId: ReviewSessionId,
  ): Promise<Result<PreparedReviewSession, PrepareReviewSessionFailure>> {
    const stored = await this.dependencies.sessions.load(
      input.profileId,
      sessionId,
    );
    if (stored._tag === "ok")
      return ok({ session: stored.value, disposition: "resumed" });
    if (stored.error.reason !== "not_found") {
      if (stored.error.reason !== "invalid_stored_value")
        return err({ _tag: "SessionStorageUnavailable" });
      const quarantined = await this.dependencies.artifacts.quarantine(
        input.profileId,
        sessionId,
      );
      if (quarantined._tag === "err")
        return err({ _tag: "SessionStorageUnavailable" });
    }
    const started = await ReviewPreparationJournal.begin(
      this.dependencies.paths,
      input.profileId,
      sessionId,
    );
    if (started._tag === "ok")
      return await this.commit(
        input,
        profile,
        revision,
        sessionId,
        started.value,
      );
    if (started.error.reason !== "journal_exists")
      return err({ _tag: "SessionStorageUnavailable" });
    // A live journal from an interrupted preparation is already at this
    // path — recover that one session (never the whole-tree `recover()`,
    // which would deadlock re-acquiring the profile lock `prepare()` is
    // already holding) and retry `begin()` exactly once. If it still finds
    // a journal on the second attempt, recovery could not clear it, so this
    // reports a failure instead of retrying forever.
    await ReviewPreparationJournal.recoverSession(
      this.dependencies.paths,
      this.dependencies.worktrees,
      input.profileId,
      sessionId,
      // This call is only reachable from inside `this.serialized(...)`
      // above (always active) and, when configured, the profile-wide
      // `lifecycleGate.withProfileLock` in `prepare()` — see
      // `recoverSession`'s doc comment for why that lock is required.
      "profile-lock-held",
      this.dependencies.sessions,
      this.dependencies.diagnostics,
    );
    const retried = await ReviewPreparationJournal.begin(
      this.dependencies.paths,
      input.profileId,
      sessionId,
    );
    if (retried._tag === "err")
      return err({ _tag: "SessionStorageUnavailable" });
    return await this.commit(
      input,
      profile,
      revision,
      sessionId,
      retried.value,
    );
  }

  private async commit(
    input: PrepareReviewSessionInput,
    profile: WorkspaceProfileConfig,
    revision: ReviewRevision,
    sessionId: ReviewSessionId,
    journal: ReviewPreparationJournal,
  ): Promise<Result<PreparedReviewSession, PrepareReviewSessionFailure>> {
    const current = await this.dependencies.github.getPullRequest({
      profile,
      pr: input.pullRequest,
    });
    if (current._tag === "err")
      return await this.abort(journal, { _tag: "GitHubReadUnavailable" });
    if (input.expectedPullRequestState === "non_open" && current.value.isOpen)
      return await this.abort(journal, { _tag: "PullRequestStateChanged" });
    const currentRevision = reviewRevisionOf(current.value);
    if (
      currentRevision === undefined ||
      !sameReviewRevision(currentRevision, revision)
    )
      return await this.abort(journal, { _tag: "HeadChanged" });
    const matchingRepo = profile.repos.find((candidate) =>
      sameRepositoryIdentity(candidate, input.pullRequest),
    );
    const worktreePath = this.dependencies.paths.worktreeDirectory(
      input.profileId,
      sessionId,
    );
    if (matchingRepo?.localPath !== undefined) {
      const recorded = await journal.recordWorktree({
        path: worktreePath,
        repositoryPath: matchingRepo.localPath,
      });
      if (recorded._tag === "err")
        return await this.abort(journal, { _tag: "SessionStorageUnavailable" });
    }
    const worktreePrepareInput: MutableWorktreePrepareInput = {
      profileId: input.profileId,
      profile,
      host: input.pullRequest.host,
      owner: input.pullRequest.owner,
      repo: input.pullRequest.repo,
      number: input.pullRequest.number,
      baseSha: revision.baseSha,
      sha: revision.headSha,
      sessionId,
    };
    if (matchingRepo?.localPath !== undefined)
      worktreePrepareInput.localPath = matchingRepo.localPath;
    const prepared =
      await this.dependencies.worktrees.prepare(worktreePrepareInput);
    // Clear the journal's advance worktree record whenever no worktree
    // actually exists on disk yet — an `ok` metadata-only result, or
    // `prepare` failing before (or, for a marker-write failure, cleaning up
    // after) ever creating one. This must run before any `abort` call below,
    // because a storage fault that takes the cache root with it also makes
    // `validatedDeletionSet` reject the recorded path, which would report
    // `PreparationCleanupUnavailable` in place of this call's real failure.
    // A path that DOES exist (a real "worktree" mode result) is left
    // recorded so a later failure can still clean it up.
    if (!(await exists(worktreePath))) {
      const cleared = await journal.clearWorktree();
      if (cleared._tag === "err")
        return await this.abort(journal, { _tag: "SessionStorageUnavailable" });
    }
    if (prepared._tag === "err")
      return await this.abort(journal, mapWorktreeFailure(prepared.error));
    const artifacts = await this.writeArtifacts({
      input,
      profile,
      headSha: revision.headSha,
      baseSha: revision.baseSha,
      sessionId,
      worktreePath,
      prepared: prepared.value,
      journal,
    });
    if (artifacts._tag === "err") return artifacts;
    const verified = await this.dependencies.github.getPullRequest({
      profile,
      pr: input.pullRequest,
    });
    if (verified._tag === "err")
      return await this.abort(journal, { _tag: "GitHubReadUnavailable" });
    if (input.expectedPullRequestState === "non_open" && verified.value.isOpen)
      return await this.abort(journal, { _tag: "PullRequestStateChanged" });
    const verifiedRevision = reviewRevisionOf(verified.value);
    if (
      verifiedRevision === undefined ||
      !sameReviewRevision(verifiedRevision, revision)
    )
      return await this.abort(journal, { _tag: "HeadChanged" });
    const patchPath = parseAbsolutePath(
      this.dependencies.paths.patchFile(input.profileId, sessionId),
    );
    const parsedWorktreePath = parseAbsolutePath(worktreePath);
    if (patchPath._tag === "err" || parsedWorktreePath._tag === "err")
      return await this.abort(journal, { _tag: "PreparationUnavailable" });
    const committing = await journal.markCommitting();
    if (committing._tag === "err")
      return await this.abort(journal, { _tag: "SessionStorageUnavailable" });
    const prContext: MutablePrContext = {
      title: current.value.title,
      author: current.value.author,
      headBranch: current.value.headBranch,
      baseBranch: current.value.baseBranch,
    };
    if (current.value.description !== undefined)
      prContext.description = current.value.description;
    const sessionInput: MutableCreateReviewSessionInput = {
      key: {
        profileId: input.profileId,
        host: input.pullRequest.host,
        owner: input.pullRequest.owner,
        repo: input.pullRequest.repo,
        prNumber: input.pullRequest.number,
        ...revision,
      },
      pr: {
        ...revision,
        isDraft: current.value.isDraft,
        isOpen: current.value.isOpen,
      },
      prContext,
      patchPath: patchPath.value,
      worktree: { path: parsedWorktreePath.value, headSha: revision.headSha },
      createdAt: this.dependencies.now(),
    };
    if (prepared.value.mode === "metadata_only")
      sessionInput.localCheckoutWarning = prepared.value.warning;
    if (artifacts.value.canonicalPatchHash !== undefined)
      sessionInput.canonicalPatchHash = artifacts.value.canonicalPatchHash;
    const session = createReviewSession(sessionInput);
    const saved = await this.dependencies.sessions.save(session);
    if (saved._tag === "err")
      return await this.abort(journal, { _tag: "SessionStorageUnavailable" });
    await journal.complete();
    return ok({ session, disposition: "prepared" });
  }

  private async writeArtifacts(input: {
    readonly input: PrepareReviewSessionInput;
    readonly profile: WorkspaceProfileConfig;
    readonly headSha: GitSha;
    readonly baseSha: GitSha;
    readonly sessionId: ReviewSessionId;
    readonly worktreePath: string;
    readonly prepared: ManagedWorktree | MetadataOnlyReview;
    readonly journal: ReviewPreparationJournal;
  }): Promise<Result<WriteArtifactsResult, PrepareReviewSessionFailure>> {
    const patchPath = this.dependencies.paths.patchFile(
      input.input.profileId,
      input.sessionId,
    );
    const preparedWorktreePath =
      input.prepared.mode === "worktree"
        ? parseAbsolutePath(input.prepared.path)
        : undefined;
    if (preparedWorktreePath?._tag === "err")
      return await this.abort(input.journal, {
        _tag: "PreparationUnavailable",
      });
    const fetchedRefs =
      input.prepared.mode !== "worktree" || preparedWorktreePath === undefined
        ? undefined
        : createFetchedDiffRefs({
            repositoryPath: preparedWorktreePath.value,
            baseRef: input.prepared.baseRef,
            headRef: input.prepared.headRef,
            baseSha: input.baseSha,
            headSha: input.headSha,
          });
    if (fetchedRefs?._tag === "err")
      return await this.abort(input.journal, {
        _tag: "PreparationUnavailable",
      });
    // Worktree mode's primary `diff` runs local `git diff`; only GitHub's
    // compare rendering proves revision identity (ADR 0026), so fetch it
    // concurrently here rather than serially after the primary diff.
    const canonicalDiff =
      fetchedRefs === undefined
        ? undefined
        : this.dependencies.github.getPullRequestDiff({
            profile: input.profile,
            pr: input.input.pullRequest,
            snapshot: { baseSha: input.baseSha, headSha: input.headSha },
          });
    const [comments, checks, diff, canonical] = await Promise.all([
      this.dependencies.github.getPullRequestComments({
        profile: input.profile,
        pr: input.input.pullRequest,
      }),
      this.dependencies.github.getPullRequestChecks({
        profile: input.profile,
        pr: input.input.pullRequest,
        headSha: input.headSha,
      }),
      this.dependencies.github.getPullRequestDiff({
        profile: input.profile,
        pr: input.input.pullRequest,
        ...(fetchedRefs === undefined
          ? { snapshot: { baseSha: input.baseSha, headSha: input.headSha } }
          : { fetchedRefs: fetchedRefs.value }),
      }),
      canonicalDiff ?? Promise.resolve(undefined),
    ]);
    if (comments._tag === "err" || checks._tag === "err" || diff._tag === "err")
      return await this.abort(input.journal, {
        _tag: "PreparationUnavailable",
      });
    if ((await input.journal.record(patchPath))._tag === "err")
      return await this.abort(input.journal, {
        _tag: "SessionStorageUnavailable",
      });
    const normalizedPatch = normalizeReviewPatch(diff.value);
    const wrotePatch = await writeAtomicFile(patchPath, normalizedPatch);
    if (wrotePatch._tag === "err")
      return await this.abort(input.journal, {
        _tag: "PreparationUnavailable",
      });
    // The canonical hash always comes from GitHub's compare rendering: when
    // there is no worktree, `diff` already is that rendering; otherwise it
    // is the extra `canonical` fetch above. A failed fetch or an unparsable
    // hash leaves the hash absent rather than failing preparation — opening
    // a PR must never become more fragile because of this proof (ADR 0026).
    let canonicalPatchHash: ContentHash | undefined;
    if (fetchedRefs === undefined) {
      const parsed = parseContentHash(
        hashReviewArtifactContent(normalizedPatch),
      );
      if (parsed._tag === "ok") canonicalPatchHash = parsed.value;
    } else if (canonical !== undefined && canonical._tag === "ok") {
      const parsed = parseContentHash(
        hashReviewArtifactContent(normalizeReviewPatch(canonical.value)),
      );
      if (parsed._tag === "ok") canonicalPatchHash = parsed.value;
    }
    const contextPath = this.dependencies.paths.preparedContextFile(
      input.input.profileId,
      input.sessionId,
    );
    const reviewInputPath = this.dependencies.paths.preparedReviewInputFile(
      input.input.profileId,
      input.sessionId,
    );
    const debugPath = this.dependencies.paths.preparedDebugFile(
      input.input.profileId,
      input.sessionId,
    );
    for (const path of [contextPath, reviewInputPath, debugPath]) {
      if ((await input.journal.record(path))._tag === "err")
        return await this.abort(input.journal, {
          _tag: "SessionStorageUnavailable",
        });
    }
    const context = await this.dependencies.context.prepare({
      worktreePath:
        input.prepared.mode === "worktree"
          ? input.prepared.path
          : input.worktreePath,
      preparedDirectory: dirname(contextPath),
      pr: {
        title: `${input.input.pullRequest.owner}/${input.input.pullRequest.repo}#${input.input.pullRequest.number}`,
        headSha: input.headSha,
      },
      comments: comments.value,
      checks: checks.value,
      changedFiles: changedFiles(diff.value),
      patch: {
        path: patchPath,
        sha256: hashReviewArtifactContent(normalizedPatch),
      },
      rulePaths: input.profile.rulePaths,
    });
    const artifactResult: MutableWriteArtifactsResult = {};
    if (canonicalPatchHash !== undefined)
      artifactResult.canonicalPatchHash = canonicalPatchHash;
    return context._tag === "ok"
      ? ok(artifactResult)
      : await this.abort(input.journal, { _tag: "PreparationUnavailable" });
  }

  private async abort(
    journal: ReviewPreparationJournal,
    failure: PrepareReviewSessionFailure,
  ): Promise<Result<never, PrepareReviewSessionFailure>> {
    const cleaned = await journal.cleanup(this.dependencies.worktrees);
    if (this.dependencies.diagnostics !== undefined)
      await this.dependencies.diagnostics.record({
        profileId: journal.profileId,
        sessionId: journal.sessionId,
        category: "preparation",
        phase:
          cleaned._tag === "ok" ? "preparation-failure" : "preparation-cleanup",
        retryable: true,
        detail: failure._tag,
      });
    return cleaned._tag === "ok"
      ? err(failure)
      : err({ _tag: "PreparationCleanupUnavailable" });
  }

  private async serialized<T>(
    profileId: WorkspaceProfileId,
    sessionId: ReviewSessionId,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.locks.run(`${profileId}:${sessionId}`, operation);
  }
}

/**
 * Reuses the existing storage tag rather than adding a parallel one:
 * `SessionStorageUnavailable` already means "preparation failed for a local
 * storage reason" everywhere else in this module.
 */
function mapWorktreeFailure(
  failure: WorktreeFailure,
): PrepareReviewSessionFailure {
  switch (failure._tag) {
    case "GitHubAuthenticationFailed":
      return { _tag: "GitHubAuthenticationFailed" };
    case "WorktreeStorageUnavailable":
      return { _tag: "SessionStorageUnavailable" };
    case "GitWorktreeFailed":
      return { _tag: "PreparationUnavailable" };
  }
}

function reviewRevisionOf(input: {
  readonly headSha: GitSha;
  readonly baseSha?: GitSha;
}): ReviewRevision | undefined {
  return input.baseSha === undefined
    ? undefined
    : { headSha: input.headSha, baseSha: input.baseSha };
}

/**
 * Reads the new-side paths through the shared tokenizer rather than a `+++ b/`
 * prefix test, which silently dropped every git-quoted path (a space, a quote,
 * or a non-ASCII byte is enough) and would have read a hunk body line beginning
 * with `+++ b/` as a file.
 */
function changedFiles(diff: string): ReadonlyArray<string> {
  return tokenizeUnifiedPatch(diff).flatMap((token) =>
    token.kind === "new_file_path" && token.path !== "/dev/null"
      ? [token.path]
      : [],
  );
}
