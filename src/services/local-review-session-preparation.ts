import { writeAtomicFile } from "../adapters/storage/json-file";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewArtifactStorage } from "../adapters/storage/review-artifact-storage";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  createReviewSessionId,
  parseAbsolutePath,
  parseContentHash,
  type AbsolutePath,
  type GitHubHost,
  type GitHubOwner,
  type GitHubRepoName,
  type GitSha,
  type IsoTimestamp,
  type WorkspaceProfileId,
} from "../domain/ids";
import { definedProps } from "../domain/defined-props";
import {
  listPatchTouchedPaths,
  type LocalPatchView,
} from "../domain/local-patch-view";
import { err, ok, type Result } from "../domain/result";
import type { ReviewIdentity } from "../domain/review";
import {
  createLocalReviewSession,
  isPullRequestReviewSession,
  type LocalReviewSession,
  type LocalSessionViewPatch,
  type ReviewRevision,
} from "../domain/review-session";
import type {
  LocalReviewSource,
  LocalReviewSourceRequest,
} from "../domain/review-source";
import {
  listLocalBranches,
  type LocalBranchListing,
} from "./local-base-inference";
import type {
  LocalReviewRevisionFailure,
  LocalReviewRevisionService,
} from "./local-review-revision-service";
import {
  configuredLocalPath,
  listRepositoryCheckouts,
  findProfileCheckout,
  missingCheckout,
  resolveLocalReviewCheckout,
  type LocalCheckoutFailure,
  type LocalReviewCheckout,
  type RepositoryCheckout,
} from "./local-checkout";
import { hashReviewArtifactContent } from "./review-artifact-hash";
import type { ReviewDiagnosticService } from "./review-diagnostic-service";
import type { ReviewLifecycleGate } from "./review-lifecycle-gate";
import { exists, ReviewPreparationJournal } from "./review-preparation-journal";
import type {
  GitReadExecutor,
  ReviewWorktreeService,
} from "./review-worktree-service";

/** A refined request to open a local Review on one profile repository. */
export type LocalReviewOpenRequest = {
  readonly profileId: WorkspaceProfileId;
  readonly repository: {
    readonly host: GitHubHost;
    readonly owner: GitHubOwner;
    readonly repo: GitHubRepoName;
  };
  readonly request: LocalReviewSourceRequest;
};

/** A local source read from the checkout: the Review it keys and the revision it pins. */
export type ResolvedLocalReview = LocalReviewCheckout & {
  readonly identity: ReviewIdentity<LocalReviewSource>;
  readonly revision: ReviewRevision;
  /** The checkout `HEAD` under a shared Review's Local snapshot; absent for the other kinds. */
  readonly checkoutHeadSha?: GitSha;
};

export type LocalReviewPreparationFailure =
  | { readonly _tag: "ProfileNotFound" }
  | { readonly _tag: "ProfileUnavailable" }
  | LocalCheckoutFailure
  | LocalReviewRevisionFailure
  | { readonly _tag: "SessionStorageUnavailable" }
  | { readonly _tag: "PreparationUnavailable" }
  | { readonly _tag: "PreparationCleanupUnavailable" };

type LocalPreparationDependencies = {
  readonly profiles: Pick<ProfileStore, "load">;
  readonly sessions: ReviewSessionStore;
  readonly revisions: LocalReviewRevisionService;
  readonly worktrees: ReviewWorktreeService;
  readonly artifacts: Pick<ReviewArtifactStorage, "quarantine">;
  readonly paths: PatchdeskPaths;
  readonly git: GitReadExecutor;
  readonly lifecycleGate: ReviewLifecycleGate;
  readonly now: () => IsoTimestamp;
  readonly diagnostics?: Pick<ReviewDiagnosticService, "record">;
};

/**
 * Prepares one immutable session for a local Review source (ADR 0050): the
 * patch as `git diff` writes it and a detached worktree at the head. The same
 * content resolves to the same head and base, so it resumes the same session.
 */
export class LocalReviewSessionPreparation {
  constructor(private readonly dependencies: LocalPreparationDependencies) {}

  /** The live checkouts of a profile repository that a local Review may name (#489). */
  async listCheckouts(
    profileId: WorkspaceProfileId,
    repository: LocalReviewOpenRequest["repository"],
  ): Promise<
    Result<ReadonlyArray<RepositoryCheckout>, LocalReviewPreparationFailure>
  > {
    const profile = await this.loadProfile(profileId);
    if (profile._tag === "err") return profile;
    const localPath = configuredLocalPath(profile.value, repository);
    if (localPath === undefined) return err({ _tag: "RepositoryNotLocal" });
    const missing = await missingCheckout(localPath);
    if (missing !== undefined) return err(missing);
    const checkouts = await listRepositoryCheckouts(
      this.dependencies,
      localPath,
    );
    return checkouts === undefined
      ? err({ _tag: "LocalGitFailed" })
      : ok(checkouts);
  }

  /** The profile repository and live checkout containing `directory`. */
  async findCheckout(profileId: WorkspaceProfileId, directory: AbsolutePath) {
    const profile = await this.loadProfile(profileId);
    if (profile._tag === "err") return profile;
    return findProfileCheckout(this.dependencies, profile.value, directory);
  }

  /**
   * The local branches of the checkout `checkout` names, and the base a
   * shared Review opened there would infer (#555), with the checkout as a
   * source stores it: absent for the configured one, however it was named.
   */
  async listBranches(
    profileId: WorkspaceProfileId,
    repository: LocalReviewOpenRequest["repository"],
    checkout: AbsolutePath | undefined,
  ): Promise<
    Result<
      {
        readonly listing: LocalBranchListing;
        readonly checkout?: AbsolutePath;
      },
      LocalReviewPreparationFailure
    >
  > {
    const profile = await this.loadProfile(profileId);
    if (profile._tag === "err") return profile;
    const resolved = await resolveLocalReviewCheckout(
      this.dependencies,
      profile.value,
      repository,
      checkout,
    );
    if (resolved._tag === "err") return resolved;
    const listing = await listLocalBranches(
      this.dependencies.git,
      resolved.value.checkoutPath,
    );
    return listing._tag === "ok"
      ? ok({
          listing: listing.value,
          ...definedProps({ checkout: resolved.value.checkout }),
        })
      : listing;
  }

  /** Reads the source from the checkout the request names; a working tree is snapshotted here. */
  async resolve(
    input: LocalReviewOpenRequest,
  ): Promise<Result<ResolvedLocalReview, LocalReviewPreparationFailure>> {
    const profile = await this.loadProfile(input.profileId);
    if (profile._tag === "err") return profile;
    const checkout = await resolveLocalReviewCheckout(
      this.dependencies,
      profile.value,
      input.repository,
      input.request.checkout,
    );
    if (checkout._tag === "err") return checkout;
    const resolved = await this.dependencies.revisions.resolve(
      input.profileId,
      checkout.value.checkoutPath,
      input.request,
    );
    if (resolved._tag === "err") return resolved;
    return ok({
      ...checkout.value,
      identity: {
        profileId: input.profileId,
        host: input.repository.host,
        owner: input.repository.owner,
        repo: input.repository.repo,
        source: {
          ...resolved.value.source,
          ...definedProps({ checkout: checkout.value.checkout }),
        },
      },
      revision: resolved.value.revision,
      ...definedProps({ checkoutHeadSha: resolved.value.checkoutHeadSha }),
    });
  }

  private async loadProfile(profileId: WorkspaceProfileId) {
    const profile = await this.dependencies.profiles.load(profileId);
    if (profile._tag === "ok") return profile;
    return err({
      _tag:
        profile.error.reason === "not_found"
          ? ("ProfileNotFound" as const)
          : ("ProfileUnavailable" as const),
    });
  }

  async prepare(
    resolved: ResolvedLocalReview,
  ): Promise<Result<LocalReviewSession, LocalReviewPreparationFailure>> {
    return this.dependencies.lifecycleGate.withProfileLock(
      resolved.identity.profileId,
      () => this.prepareUnderProfileLock(resolved),
    );
  }

  private async prepareUnderProfileLock(
    resolved: ResolvedLocalReview,
  ): Promise<Result<LocalReviewSession, LocalReviewPreparationFailure>> {
    const { profileId } = resolved.identity;
    const key = { ...resolved.identity, ...resolved.revision };
    const sessionId = createReviewSessionId(key);
    const stored = await this.dependencies.sessions.load(profileId, sessionId);
    if (stored._tag === "ok" && !isPullRequestReviewSession(stored.value))
      return this.withWorktree(resolved, stored.value);
    if (stored._tag === "err" && stored.error.reason !== "not_found") {
      if (stored.error.reason !== "invalid_stored_value")
        return err({ _tag: "SessionStorageUnavailable" });
      const quarantined = await this.dependencies.artifacts.quarantine(
        profileId,
        sessionId,
      );
      if (quarantined._tag === "err")
        return err({ _tag: "SessionStorageUnavailable" });
    }
    let journal = await ReviewPreparationJournal.begin(
      this.dependencies.paths,
      profileId,
      sessionId,
    );
    if (journal._tag === "err" && journal.error.reason === "journal_exists") {
      // An interrupted preparation of this same session left its journal;
      // recover that one session, then begin exactly once more.
      await ReviewPreparationJournal.recoverSession(
        this.dependencies.paths,
        this.dependencies.worktrees,
        profileId,
        sessionId,
        "profile-lock-held",
        this.dependencies.sessions,
        this.dependencies.diagnostics,
      );
      journal = await ReviewPreparationJournal.begin(
        this.dependencies.paths,
        profileId,
        sessionId,
      );
    }
    if (journal._tag === "err")
      return err({ _tag: "SessionStorageUnavailable" });
    return this.writeSession(resolved, key, journal.value);
  }

  /**
   * The stored session, with its worktree checked out again when retention
   * removed it: a session a retained Insight names keeps only its directory
   * (#474), and the checkout can return to that same snapshot.
   */
  private async withWorktree(
    resolved: ResolvedLocalReview,
    session: LocalReviewSession,
  ): Promise<Result<LocalReviewSession, LocalReviewPreparationFailure>> {
    if (await exists(session.worktree.path)) {
      // A checkout moved on disk leaves the worktree's `.git` file naming its old place (#488).
      await this.dependencies.worktrees.repairWorktree(
        resolved.repositoryPath,
        session.worktree.path,
      );
      return ok(session);
    }
    const rebuilt = await this.dependencies.worktrees.prepareLocal({
      profileId: session.key.profileId,
      sessionId: session.id,
      localPath: resolved.repositoryPath,
      headSha: session.worktree.headSha,
    });
    return rebuilt._tag === "ok"
      ? ok(session)
      : err({ _tag: "PreparationUnavailable" });
  }

  private async writeSession(
    resolved: ResolvedLocalReview,
    key: LocalReviewSession["key"],
    journal: ReviewPreparationJournal,
  ): Promise<Result<LocalReviewSession, LocalReviewPreparationFailure>> {
    const { profileId } = resolved.identity;
    const sessionId = journal.sessionId;
    const worktreePath = this.dependencies.paths.worktreeDirectory(
      profileId,
      sessionId,
    );
    const recorded = await journal.recordWorktree({
      path: worktreePath,
      repositoryPath: resolved.repositoryPath,
    });
    if (recorded._tag === "err")
      return this.abort(journal, { _tag: "SessionStorageUnavailable" });
    const worktree = await this.dependencies.worktrees.prepareLocal({
      profileId,
      sessionId,
      localPath: resolved.repositoryPath,
      headSha: resolved.revision.headSha,
    });
    if (worktree._tag === "err") {
      // Recovery must not be sent to remove a worktree that was never made.
      if (!(await exists(worktreePath))) await journal.clearWorktree();
      return this.abort(journal, {
        _tag:
          worktree.error._tag === "WorktreeStorageUnavailable"
            ? "SessionStorageUnavailable"
            : "PreparationUnavailable",
      });
    }
    const patches = await this.renderViewPatches(resolved);
    if (patches._tag === "err") return this.abort(journal, patches.error);
    const files = patches.value.map((rendered) => ({
      ...rendered,
      path:
        rendered.view === "combined"
          ? this.dependencies.paths.patchFile(profileId, sessionId)
          : this.dependencies.paths.viewPatchFile(
              profileId,
              sessionId,
              rendered.view,
            ),
    }));
    if (
      (await journal.recordAll(files.map((file) => file.path)))._tag === "err"
    )
      return this.abort(journal, { _tag: "SessionStorageUnavailable" });
    const stored = new Map<LocalPatchView, LocalSessionViewPatch>();
    for (const file of files) {
      if ((await writeAtomicFile(file.path, file.patch))._tag === "err")
        return this.abort(journal, { _tag: "SessionStorageUnavailable" });
      const patchPath = parseAbsolutePath(file.path);
      const patchHash = parseContentHash(hashReviewArtifactContent(file.patch));
      if (patchPath._tag === "err" || patchHash._tag === "err")
        return this.abort(journal, { _tag: "PreparationUnavailable" });
      stored.set(file.view, {
        patchPath: patchPath.value,
        patchHash: patchHash.value,
        paths: listPatchTouchedPaths(file.patch),
      });
    }
    const combined = stored.get("combined");
    const committed = stored.get("committed");
    const uncommitted = stored.get("uncommitted");
    const parsedWorktreePath = parseAbsolutePath(worktree.value.path);
    if (combined === undefined || parsedWorktreePath._tag === "err")
      return this.abort(journal, { _tag: "PreparationUnavailable" });
    if ((await journal.markCommitting())._tag === "err")
      return this.abort(journal, { _tag: "SessionStorageUnavailable" });
    const session = createLocalReviewSession({
      key,
      patchPath: combined.patchPath,
      canonicalPatchHash: combined.patchHash,
      worktree: {
        path: parsedWorktreePath.value,
        headSha: resolved.revision.headSha,
      },
      createdAt: this.dependencies.now(),
      ...definedProps({
        checkoutHeadSha: resolved.checkoutHeadSha,
        viewPatches:
          committed === undefined || uncommitted === undefined
            ? undefined
            : { combined, committed, uncommitted },
      }),
    });
    const saved = await this.dependencies.sessions.save(session);
    if (saved._tag === "err")
      return this.abort(journal, { _tag: "SessionStorageUnavailable" });
    await journal.complete();
    return ok(session);
  }

  /**
   * The session's patches: Combined always, and on a shared Review also
   * Committed and Uncommitted around the checkout `HEAD`. Any patch over the
   * git output cap refuses the whole open (#556 D2).
   */
  private async renderViewPatches(
    resolved: ResolvedLocalReview,
  ): Promise<
    Result<
      ReadonlyArray<{ readonly view: LocalPatchView; readonly patch: string }>,
      LocalReviewPreparationFailure
    >
  > {
    const { baseSha, headSha } = resolved.revision;
    const revisions: Array<readonly [LocalPatchView, ReviewRevision]> = [
      ["combined", resolved.revision],
    ];
    if (resolved.checkoutHeadSha !== undefined)
      revisions.push(
        ["committed", { baseSha, headSha: resolved.checkoutHeadSha }],
        ["uncommitted", { baseSha: resolved.checkoutHeadSha, headSha }],
      );
    const rendered: Array<{ view: LocalPatchView; patch: string }> = [];
    for (const [view, revision] of revisions) {
      const patch = await this.dependencies.revisions.renderPatch(
        resolved.checkoutPath,
        revision,
      );
      if (patch._tag === "err")
        return err(
          patch.error._tag === "PatchTooLarge"
            ? patch.error
            : { _tag: "PreparationUnavailable" },
        );
      rendered.push({ view, patch: patch.value });
    }
    return ok(rendered);
  }

  private async abort(
    journal: ReviewPreparationJournal,
    failure: LocalReviewPreparationFailure,
  ): Promise<Result<never, LocalReviewPreparationFailure>> {
    const cleaned = await journal.cleanup(this.dependencies.worktrees);
    await this.dependencies.diagnostics?.record({
      profileId: journal.profileId,
      sessionId: journal.sessionId,
      category: "preparation",
      phase:
        cleaned._tag === "ok" ? "preparation-failure" : "preparation-cleanup",
      retryable: true,
      detail: failure._tag,
    });
    return err(
      cleaned._tag === "ok"
        ? failure
        : { _tag: "PreparationCleanupUnavailable" },
    );
  }
}
