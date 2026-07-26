import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

import type { GitHubReader } from "../adapters/github/github-adapter";
import { createFetchedDiffRefs } from "../adapters/github/github-adapter";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import type { ReviewArtifactStorage } from "../adapters/storage/review-artifact-storage";
import {
  createReviewSessionId,
  parseAbsolutePath,
  parseContentHash,
  type GitSha,
  type IsoTimestamp,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../domain/ids";
import type { PullRequestRef } from "../domain/pull-request";
import { createReviewSession, type ReviewSession } from "../domain/review-session";
import type { ReviewScope } from "../domain/review-comparison";
import type { PriorFindingEvidence } from "../domain/finding-lifecycle";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import { err, ok, type Result } from "../domain/result";
import { preparedReviewArtifacts } from "./review-attempt-artifacts";
import type { ReviewComparisonService } from "./review-comparison-service";
import type { ReviewContextService } from "./review-context-service";
import {
  ReviewPreparationJournal,
  promoteStagedArtifact,
} from "./review-preparation-journal";
import type {
  ManagedWorktree,
  MetadataOnlyReview,
  ReviewWorktreeService,
} from "./review-worktree-service";

export type ReviewOpenMode =
  | { readonly kind: "full" }
  | { readonly kind: "incremental"; readonly baseSessionId: ReviewSessionId };

/** A refined local application command; the workbench controller constructs it. */
export type PrepareReviewSessionInput = {
  readonly profileId: WorkspaceProfileId;
  readonly pullRequest: PullRequestRef;
  readonly mode: ReviewOpenMode;
};

export type PreparedReviewSession = {
  readonly session: ReviewSession;
  readonly disposition: "resumed" | "prepared";
};

export type PrepareReviewSessionFailure =
  | { readonly _tag: "ProfileNotFound" }
  | { readonly _tag: "ProfileUnavailable" }
  | { readonly _tag: "InvalidIncrementalBase" }
  | { readonly _tag: "IncrementalBaseNotFound" }
  | { readonly _tag: "GitHubReadUnavailable" }
  | { readonly _tag: "HeadChanged" }
  | { readonly _tag: "SessionStorageUnavailable" }
  | { readonly _tag: "PreparationUnavailable" }
  | { readonly _tag: "PreparationCleanupUnavailable" };

type PreparationDependencies = {
  readonly profiles: ProfileStore;
  readonly sessions: ReviewSessionStore;
  readonly github: Pick<
    GitHubReader,
    | "getPullRequest"
    | "getPullRequestComments"
    | "getPullRequestChecks"
    | "getPullRequestDiff"
    | "compareRevisions"
  >;
  readonly paths: PatchdeskPaths;
  readonly now: () => IsoTimestamp;
  readonly worktrees: ReviewWorktreeService;
  readonly context: ReviewContextService;
  readonly comparisons?: ReviewComparisonService;
  readonly artifacts: ReviewArtifactStorage;
};

/**
 * Owns the whole lifecycle that turns a refined selection into an existing or
 * newly prepared immutable, read-only Review Session: current PR reads, resume
 * eligibility, full versus incremental scope, keyed serialization, journalled
 * artifact staging, current-head rechecks, immutable artifact persistence, and
 * exhaustive cleanup. It never allocates or mutates a Review Attempt and never
 * invokes a workflow.
 */
export class ReviewSessionPreparation {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: PreparationDependencies) {}

  async prepare(
    input: PrepareReviewSessionInput,
  ): Promise<Result<PreparedReviewSession, PrepareReviewSessionFailure>> {
    const deps = this.dependencies;
    const profile = await deps.profiles.load(input.profileId);
    if (profile._tag === "err") {
      return err({ _tag: profile.error.reason === "not_found" ? "ProfileNotFound" : "ProfileUnavailable" });
    }
    const current = await deps.github.getPullRequest({
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
    return this.serialized(input.profileId, sessionId, () =>
      this.prepareSerialized(input, profile.value, current.value.headSha, sessionId),
    );
  }

  private async prepareSerialized(
    input: PrepareReviewSessionInput,
    profile: WorkspaceProfileConfig,
    headSha: GitSha,
    sessionId: ReviewSessionId,
  ): Promise<Result<PreparedReviewSession, PrepareReviewSessionFailure>> {
    const deps = this.dependencies;
    const stored = await deps.sessions.load(input.profileId, sessionId);
    // Opening a PR creates or resumes its immutable, read-only session. Starting a
    // model attempt is deliberately a separate explicit action. A saved result
    // remains useful even if a previous local checkout or its patch has been
    // cleaned up; opening it must never silently rerun preparation or the model.
    if (stored._tag === "ok") {
      const preparedPatch = await readFile(stored.value.patchPath, "utf8").catch(() => undefined);
      if (preparedPatch !== undefined || stored.value.state._tag === "ReviewCompleted") {
        return ok({ session: stored.value, disposition: "resumed" });
      }
    }
    if (stored._tag === "err" && stored.error.reason !== "not_found") {
      // An unreadable stored session is preserved by renaming it into the
      // quarantine directories before preparing a fresh replacement. A
      // persisted Running state must never be moved aside, so the rename only
      // happens when the storage layer confirms the session is not live.
      if (stored.error.reason === "invalid_stored_value") {
        const running = await deps.sessions.isRecordedRunning(input.profileId, sessionId);
        if (running._tag === "err" || running.value) {
          return err({ _tag: "SessionStorageUnavailable" });
        }
        const quarantined = await deps.artifacts.quarantine(input.profileId, sessionId);
        if (quarantined._tag === "err") {
          return err({ _tag: "SessionStorageUnavailable" });
        }
      } else {
        return err({ _tag: "SessionStorageUnavailable" });
      }
    }

    const journal = await ReviewPreparationJournal.begin(deps.paths, input.profileId, sessionId);
    if (journal._tag === "err") return err({ _tag: "SessionStorageUnavailable" });
    const pending = journal.value;

    const scope = await this.resolveScope(input, profile, headSha, sessionId, pending);
    if (scope._tag === "err") return scope;

    const created = await this.commitSession(input, profile, headSha, sessionId, scope.value, pending);
    if (created._tag === "err") return created;
    return ok({ session: created.value, disposition: "prepared" });
  }

  /**
   * Resolve the incremental scope into journal-owned staging and promote it
   * only after the head is rechecked. An unavailable or incomplete comparison
   * falls back to the truthful full-review behavior; it never produces a
   * misleading partial incremental Session.
   */
  private async resolveScope(
    input: PrepareReviewSessionInput,
    profile: WorkspaceProfileConfig,
    headSha: GitSha,
    sessionId: ReviewSessionId,
    journal: ReviewPreparationJournal,
  ): Promise<Result<ReviewScope, PrepareReviewSessionFailure>> {
    const deps = this.dependencies;
    if (input.mode.kind === "full") return ok({ kind: "full" });
    if (deps.comparisons === undefined) {
      return this.abort(journal, { _tag: "InvalidIncrementalBase" });
    }
    const base = await deps.sessions.load(input.profileId, input.mode.baseSessionId);
    if (
      base._tag === "err" ||
      base.value.key.host !== input.pullRequest.host ||
      base.value.key.owner !== input.pullRequest.owner ||
      base.value.key.repo !== input.pullRequest.repo ||
      base.value.key.prNumber !== input.pullRequest.number ||
      base.value.visibleResult === undefined
    ) {
      return this.abort(journal, { _tag: "IncrementalBaseNotFound" });
    }
    const matchingRepo = profile.repos.find(
      (candidate) =>
        candidate.host === input.pullRequest.host &&
        candidate.owner === input.pullRequest.owner &&
        candidate.repo === input.pullRequest.repo,
    );
    const prior = priorFindings(base.value);
    const staged =
      matchingRepo?.localPath === undefined
        ? await this.prepareGitHubComparison({
            profile,
            pr: input.pullRequest,
            profileId: input.profileId,
            targetSessionId: sessionId,
            baseSessionId: base.value.id,
            baseHeadSha: base.value.key.headSha,
            headSha,
            previousFindings: prior,
            stagingDirectory: journal.stagingRoot,
          })
        : await deps.comparisons.prepare({
            profileId: input.profileId,
            targetSessionId: sessionId,
            baseSessionId: base.value.id,
            baseHeadSha: base.value.key.headSha,
            headSha,
            previousFindings: prior,
            localPath: matchingRepo.localPath,
            stagingDirectory: journal.stagingRoot,
          });
    // A metadata-only comparison cannot prove all changed code was seen. Start the
    // normal full review rather than create a misleading incremental session.
    if (staged === undefined) return ok({ kind: "full" });
    if (staged._tag === "err") {
      return this.abort(
        journal,
        { _tag: staged.error.reason === "head_changed" ? "HeadChanged" : "SessionStorageUnavailable" },
      );
    }
    // The comparison can take long enough for the PR to update. Recheck immediately
    // before a saved session would reference its artifacts.
    const verified = await this.recheckHead(input, profile, headSha, journal);
    if (verified._tag === "err") return verified;
    const finals = {
      comparisonPatchPath: deps.paths.comparisonPatchFile(input.profileId, sessionId),
      comparisonMetadataPath: deps.paths.comparisonMetadataFile(input.profileId, sessionId),
      previousFindingsPath: deps.paths.previousFindingsFile(input.profileId, sessionId),
      lifecyclePath: deps.paths.findingLifecycleFile(input.profileId, sessionId),
    };
    const stagedPaths = {
      comparisonPatchPath: staged.value.comparisonPatchPath,
      comparisonMetadataPath: staged.value.comparisonMetadataPath,
      previousFindingsPath: staged.value.previousFindingsPath,
      lifecyclePath: staged.value.lifecyclePath,
    };
    for (const key of ["comparisonPatchPath", "comparisonMetadataPath", "previousFindingsPath", "lifecyclePath"] as const) {
      const promoted = await promoteStagedArtifact(journal, stagedPaths[key], finals[key]);
      if (promoted._tag === "err") {
        return this.abort(journal, { _tag: "SessionStorageUnavailable" });
      }
    }
    const comparisonPatchPath = parseAbsolutePath(finals.comparisonPatchPath);
    const comparisonMetadataPath = parseAbsolutePath(finals.comparisonMetadataPath);
    const previousFindingsPath = parseAbsolutePath(finals.previousFindingsPath);
    const lifecyclePath = parseAbsolutePath(finals.lifecyclePath);
    if (
      comparisonPatchPath._tag === "err" ||
      comparisonMetadataPath._tag === "err" ||
      previousFindingsPath._tag === "err" ||
      lifecyclePath._tag === "err"
    ) {
      return this.abort(journal, { _tag: "SessionStorageUnavailable" });
    }
    return ok({
      kind: "incremental",
      baseSessionId: base.value.id,
      baseHeadSha: base.value.key.headSha,
      headSha,
      comparisonPatchPath: comparisonPatchPath.value,
      comparisonMetadataPath: comparisonMetadataPath.value,
      previousFindingsPath: previousFindingsPath.value,
      lifecyclePath: lifecyclePath.value,
    });
  }

  /**
   * Create the immutable Session artifacts (worktree, patch, context, review
   * input, debug), recheck the head, then persist the Session and commit the
   * journal. Any failure removes every journalled artifact.
   */
  private async commitSession(
    input: PrepareReviewSessionInput,
    profile: WorkspaceProfileConfig,
    headSha: GitSha,
    sessionId: ReviewSessionId,
    scope: ReviewScope,
    journal: ReviewPreparationJournal,
  ): Promise<Result<ReviewSession, PrepareReviewSessionFailure>> {
    const deps = this.dependencies;
    const current = await deps.github.getPullRequest({ profile, pr: input.pullRequest });
    if (current._tag === "err") return this.abort(journal, { _tag: "GitHubReadUnavailable" });
    if (current.value.headSha !== headSha) return this.abort(journal, { _tag: "HeadChanged" });
    if (current.value.baseSha === undefined) return this.abort(journal, { _tag: "PreparationUnavailable" });
    const baseSha = current.value.baseSha;
    const matchingRepo = profile.repos.find(
      (candidate) =>
        candidate.host === input.pullRequest.host &&
        candidate.owner === input.pullRequest.owner &&
        candidate.repo === input.pullRequest.repo,
    );
    const patchPath = deps.paths.patchFile(input.profileId, sessionId);
    const worktreePath = deps.paths.worktreeDirectory(input.profileId, sessionId);

    if (matchingRepo?.localPath !== undefined) {
      const recorded = await journal.recordWorktree({
        path: worktreePath,
        repositoryPath: matchingRepo.localPath,
      });
      if (recorded._tag === "err") return this.abort(journal, { _tag: "SessionStorageUnavailable" });
    }
    const prepared = await deps.worktrees.prepare({
      profileId: input.profileId,
      host: input.pullRequest.host,
      owner: input.pullRequest.owner,
      repo: input.pullRequest.repo,
      number: input.pullRequest.number,
      baseSha,
      sha: headSha,
      sessionId,
      ...(matchingRepo?.localPath === undefined ? {} : { localPath: matchingRepo.localPath }),
    });
    if (prepared._tag === "err") return this.abort(journal, { _tag: "PreparationUnavailable" });

    const artifacts = await this.writePatchAndContext(
      input,
      profile,
      headSha,
      baseSha,
      sessionId,
      patchPath,
      worktreePath,
      prepared.value,
      journal,
    );
    if (artifacts._tag === "err") return artifacts;

    // Persist the Session only after every final artifact exists and the head is
    // still exact; the journal commits before the save so a crash can never make
    // recovery delete artifacts a persisted Session references.
    const verified = await this.recheckHead(input, profile, headSha, journal);
    if (verified._tag === "err") return verified;
    const committing = await journal.markCommitting();
    if (committing._tag === "err") return this.abort(journal, { _tag: "SessionStorageUnavailable" });
    const parsedPatchPath = parseAbsolutePath(patchPath);
    const parsedWorktreePath = parseAbsolutePath(worktreePath);
    if (parsedPatchPath._tag === "err" || parsedWorktreePath._tag === "err") {
      return this.abort(journal, { _tag: "PreparationUnavailable" });
    }
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
        baseSha,
        isDraft: current.value.isDraft,
        isOpen: current.value.isOpen,
      },
      prContext: {
        title: current.value.title,
        ...(current.value.description === undefined ? {} : { description: current.value.description }),
        author: current.value.author,
        headBranch: current.value.headBranch,
        baseBranch: current.value.baseBranch,
      },
      patchPath: parsedPatchPath.value,
      scope,
      worktree: { path: parsedWorktreePath.value, headSha },
      createdAt: deps.now(),
    });
    const saved = await deps.sessions.save(session);
    if (saved._tag === "err") return this.abort(journal, { _tag: "SessionStorageUnavailable" });
    await journal.complete();
    return ok(session);
  }

  private async writePatchAndContext(
    input: PrepareReviewSessionInput,
    profile: WorkspaceProfileConfig,
    headSha: GitSha,
    baseSha: GitSha,
    sessionId: ReviewSessionId,
    patchPath: string,
    worktreePath: string,
    prepared: ManagedWorktree | MetadataOnlyReview,
    journal: ReviewPreparationJournal,
  ): Promise<Result<void, PrepareReviewSessionFailure>> {
    const deps = this.dependencies;
    const preparedPath = prepared.mode === "worktree" ? parseAbsolutePath(prepared.path) : undefined;
    if (preparedPath !== undefined && preparedPath._tag === "err") {
      return this.abort(journal, { _tag: "PreparationUnavailable" });
    }
    const fetchedRefs =
      prepared.mode !== "worktree" || preparedPath === undefined
        ? undefined
        : createFetchedDiffRefs({
            repositoryPath: preparedPath.value,
            baseRef: prepared.baseRef,
            headRef: prepared.headRef,
            baseSha,
            headSha,
          });
    if (fetchedRefs !== undefined && fetchedRefs._tag === "err") {
      return this.abort(journal, { _tag: "PreparationUnavailable" });
    }
    const [comments, checks, diff] = await Promise.all([
      deps.github.getPullRequestComments({ profile, pr: input.pullRequest }),
      deps.github.getPullRequestChecks({ profile, pr: input.pullRequest, headSha }),
      deps.github.getPullRequestDiff({
        profile,
        pr: input.pullRequest,
        ...(fetchedRefs === undefined
          ? { snapshot: { baseSha, headSha } }
          : { fetchedRefs: fetchedRefs.value }),
      }),
    ]);
    if (comments._tag === "err" || checks._tag === "err" || diff._tag === "err") {
      return this.abort(journal, { _tag: "PreparationUnavailable" });
    }
    const recordedPatch = await journal.record(patchPath);
    if (recordedPatch._tag === "err") return this.abort(journal, { _tag: "SessionStorageUnavailable" });
    try {
      await mkdir(dirname(patchPath), { recursive: true });
      await writeFile(patchPath, diff.value, "utf8");
    } catch {
      return this.abort(journal, { _tag: "PreparationUnavailable" });
    }
    const artifacts = preparedReviewArtifacts(deps.paths, input.profileId, sessionId);
    for (const artifactPath of [artifacts.contextPath, artifacts.reviewInputPath, artifacts.debugPath]) {
      const recorded = await journal.record(artifactPath);
      if (recorded._tag === "err") return this.abort(journal, { _tag: "SessionStorageUnavailable" });
    }
    const context = await deps.context.prepare({
      worktreePath: prepared.mode === "worktree" ? prepared.path : worktreePath,
      attemptDirectory: dirname(artifacts.contextPath),
      pr: {
        title: `${input.pullRequest.owner}/${input.pullRequest.repo}#${input.pullRequest.number}`,
        headSha,
      },
      comments: comments.value,
      checks: checks.value,
      changedFiles: parseChangedFiles(diff.value),
      patch: { path: patchPath, sha256: "0".repeat(64) },
      rulePaths: profile.rulePaths,
    });
    if (context._tag === "err") return this.abort(journal, { _tag: "PreparationUnavailable" });
    return ok(undefined);
  }

  /** Recheck the exact head before a durable commit would reference prepared artifacts. */
  private async recheckHead(
    input: PrepareReviewSessionInput,
    profile: WorkspaceProfileConfig,
    headSha: GitSha,
    journal: ReviewPreparationJournal,
  ): Promise<Result<void, PrepareReviewSessionFailure>> {
    const verified = await this.dependencies.github.getPullRequest({ profile, pr: input.pullRequest });
    if (verified._tag === "err") return this.abort(journal, { _tag: "GitHubReadUnavailable" });
    return verified.value.headSha === headSha
      ? ok(undefined)
      : this.abort(journal, { _tag: "HeadChanged" });
  }

  /** Remove every journalled artifact; report cleanup failure so recovery can retry. */
  private async abort(
    journal: ReviewPreparationJournal,
    failure: PrepareReviewSessionFailure,
  ): Promise<Result<never, PrepareReviewSessionFailure>> {
    const cleaned = await journal.cleanup(this.dependencies.worktrees);
    return cleaned._tag === "ok" ? err(failure) : err({ _tag: "PreparationCleanupUnavailable" });
  }

  /** Serialize preparation per derived Session so concurrent opens prepare once. */
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

  private async prepareGitHubComparison(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly profileId: WorkspaceProfileId;
    readonly targetSessionId: ReviewSessionId;
    readonly baseSessionId: ReviewSessionId;
    readonly baseHeadSha: GitSha;
    readonly headSha: GitSha;
    readonly previousFindings: ReadonlyArray<PriorFindingEvidence>;
    readonly stagingDirectory: string;
  }): Promise<Awaited<ReturnType<ReviewComparisonService["prepare"]>> | undefined> {
    const deps = this.dependencies;
    if (deps.comparisons === undefined) return undefined;
    const remote = await deps.github.compareRevisions({
      profile: input.profile,
      pr: input.pr,
      baseSha: input.baseHeadSha,
      headSha: input.headSha,
      baseSessionId: input.baseSessionId,
    });
    if (remote._tag === "err" || remote.value.comparison.completeness !== "complete" || remote.value.patch === undefined) {
      return undefined;
    }
    return deps.comparisons.persist({
      profileId: input.profileId,
      targetSessionId: input.targetSessionId,
      comparison: remote.value.comparison,
      patch: remote.value.patch,
      previousFindings: input.previousFindings,
      stagingDirectory: input.stagingDirectory,
    });
  }
}

function priorFindings(session: ReviewSession): ReadonlyArray<PriorFindingEvidence> {
  const result = session.visibleResult;
  if (result === undefined) return [];
  const resultHash = createHash("sha256").update(JSON.stringify(result)).digest("hex");
  const evidence: Array<PriorFindingEvidence> = [];
  for (const finding of result.findings) {
    const token = parseContentHash(
      createHash("sha256")
        .update(`${session.id}\u0000${resultHash}\u0000${finding.id}`)
        .digest("hex"),
    );
    if (token._tag === "err") continue;
    evidence.push({
      token: token.value,
      findingId: finding.id,
      severity: finding.severity,
      ...(finding.category === undefined ? {} : { category: finding.category }),
      title: finding.title,
      explanation: finding.explanation,
      ...(finding.file === undefined ? {} : { file: finding.file }),
      wasSubmitted: session.submittedReview !== undefined,
    });
  }
  return evidence;
}

function parseChangedFiles(diff: string): ReadonlyArray<string> {
  return diff.split("\n").flatMap((line) => (line.startsWith("+++ b/") ? [line.slice(6)] : []));
}
