import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  createFetchedDiffRefs,
  type GitHubReader,
} from "../adapters/github/github-adapter";
import type { ReviewArtifactStorage } from "../adapters/storage/review-artifact-storage";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  createReviewSessionId,
  parseAbsolutePath,
  type GitSha,
  type IsoTimestamp,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../domain/ids";
import type { PullRequestRef } from "../domain/pull-request";
import {
  createReviewSession,
  type ReviewSession,
} from "../domain/review-session";
import { err, ok, type Result } from "../domain/result";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import type { ReviewContextService } from "./review-context-service";
import { hashReviewArtifactContent } from "./review-artifact-hash";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";
import type { ReviewLifecycleGate } from "./review-lifecycle-gate";
import { ReviewPreparationJournal } from "./review-preparation-journal";
import type {
  ManagedWorktree,
  MetadataOnlyReview,
  ReviewWorktreeService,
} from "./review-worktree-service";

/** A refined command to prepare one complete immutable Review session. */
export type PrepareReviewSessionInput = {
  readonly profileId: WorkspaceProfileId;
  readonly pullRequest: PullRequestRef;
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
  | { readonly _tag: "SessionStorageUnavailable" }
  | { readonly _tag: "PreparationUnavailable" }
  | { readonly _tag: "PreparationCleanupUnavailable" };

/** Sessions store GitHub's canonical complete unified patch unchanged. */
export function normalizeReviewPatch(patch: string): string {
  return patch;
}

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
  private readonly locks = new Map<string, Promise<void>>();

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
    const sessionId = createReviewSessionId({
      profileId: input.profileId,
      host: input.pullRequest.host,
      owner: input.pullRequest.owner,
      repo: input.pullRequest.repo,
      prNumber: input.pullRequest.number,
      headSha: current.value.headSha,
    });
    const run = (): Promise<
      Result<PreparedReviewSession, PrepareReviewSessionFailure>
    > =>
      this.serialized(
        input.profileId,
        sessionId,
        async () =>
          await this.prepareCurrent(
            input,
            profile.value,
            current.value.headSha,
            sessionId,
          ),
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
    headSha: GitSha,
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
    if (started._tag === "err")
      return err({ _tag: "SessionStorageUnavailable" });
    return await this.commit(input, profile, headSha, sessionId, started.value);
  }

  private async commit(
    input: PrepareReviewSessionInput,
    profile: WorkspaceProfileConfig,
    headSha: GitSha,
    sessionId: ReviewSessionId,
    journal: ReviewPreparationJournal,
  ): Promise<Result<PreparedReviewSession, PrepareReviewSessionFailure>> {
    const current = await this.dependencies.github.getPullRequest({
      profile,
      pr: input.pullRequest,
    });
    if (current._tag === "err")
      return await this.abort(journal, { _tag: "GitHubReadUnavailable" });
    if (current.value.headSha !== headSha)
      return await this.abort(journal, { _tag: "HeadChanged" });
    if (current.value.baseSha === undefined)
      return await this.abort(journal, { _tag: "PreparationUnavailable" });
    const matchingRepo = profile.repos.find(
      (candidate) =>
        candidate.host === input.pullRequest.host &&
        candidate.owner === input.pullRequest.owner &&
        candidate.repo === input.pullRequest.repo,
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
    const prepared = await this.dependencies.worktrees.prepare({
      profileId: input.profileId,
      host: input.pullRequest.host,
      owner: input.pullRequest.owner,
      repo: input.pullRequest.repo,
      number: input.pullRequest.number,
      baseSha: current.value.baseSha,
      sha: headSha,
      sessionId,
      ...(matchingRepo?.localPath === undefined
        ? {}
        : { localPath: matchingRepo.localPath }),
    });
    if (prepared._tag === "err")
      return await this.abort(journal, { _tag: "PreparationUnavailable" });
    const artifacts = await this.writeArtifacts({
      input,
      profile,
      headSha,
      baseSha: current.value.baseSha,
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
    if (verified.value.headSha !== headSha)
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
    const session = createReviewSession({
      key: {
        profileId: input.profileId,
        host: input.pullRequest.host,
        owner: input.pullRequest.owner,
        repo: input.pullRequest.repo,
        prNumber: input.pullRequest.number,
        headSha,
      },
      pr: {
        headSha,
        baseSha: current.value.baseSha,
        isDraft: current.value.isDraft,
        isOpen: current.value.isOpen,
      },
      prContext: {
        title: current.value.title,
        ...(current.value.description === undefined
          ? {}
          : { description: current.value.description }),
        author: current.value.author,
        headBranch: current.value.headBranch,
        baseBranch: current.value.baseBranch,
      },
      patchPath: patchPath.value,
      worktree: { path: parsedWorktreePath.value, headSha },
      createdAt: this.dependencies.now(),
    });
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
  }): Promise<Result<void, PrepareReviewSessionFailure>> {
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
    const [comments, checks, diff] = await Promise.all([
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
    try {
      await mkdir(dirname(patchPath), { recursive: true });
      await writeFile(patchPath, normalizedPatch, "utf8");
    } catch {
      return await this.abort(input.journal, {
        _tag: "PreparationUnavailable",
      });
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
    return context._tag === "ok"
      ? ok(undefined)
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
    const key = `${profileId}:${sessionId}`;
    const predecessor = this.locks.get(key);
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, current);
    await predecessor;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}

function changedFiles(diff: string): ReadonlyArray<string> {
  return diff
    .split("\n")
    .flatMap((line) => (line.startsWith("+++ b/") ? [line.slice(6)] : []));
}
