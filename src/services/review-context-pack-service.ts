import { readFile } from "node:fs/promises";

import * as v from "valibot";

import type { GitHubReader } from "#src/adapters/github/github-adapter";
import {
  containsSensitiveData,
  readJsonFile,
} from "#src/adapters/storage/json-file";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import type { ProfileStore } from "#src/adapters/storage/profile-store";
import {
  changeIntentProvenance,
  type ChangeIntent,
  type ChangeIntentProvenance,
  type ResolvedChangeIntent,
} from "#src/domain/change-intent";
import type { WorkspaceProfileConfig } from "#src/domain/workspace-profile";
import { definedProps } from "#src/domain/defined-props";
import type { ContentHash } from "#src/domain/ids";
import { err, ok, type Result } from "#src/domain/result";
import { reviewSourceTitle } from "#src/domain/review-source";
import {
  isPullRequestReviewSession,
  type PullRequestReviewSession,
  type ReviewSession,
} from "#src/domain/review-session";
import {
  renderStatedGoalSection,
  type StatedGoal,
} from "#src/domain/stated-goal";
import {
  resolveChangeIntent,
  type ChangeIntentUnreadable,
} from "./change-intent-resolution";
import type { GuideUpstreamCompleteness } from "#src/domain/guide-preparation";
import {
  changedPatchFiles,
  REVIEW_INPUT_HEADING,
  type ReviewContextMaterial,
  type ReviewContextService,
} from "./review-context-service";
import { exists } from "./review-preparation-journal";
import type { GitReadExecutor } from "./review-worktree-service";
import { captureModelReviewSnapshots } from "./model-review-runner";

export type ReviewContextPackFailure =
  | { readonly _tag: "ContextPackUnavailable" }
  | ChangeIntentUnreadable;

/** Why a Guide run's context could not be captured; the first two are not retryable by waiting. */
export type GuideContextFailure =
  | ReviewContextPackFailure
  | { readonly _tag: "RequiredContextUnavailable" }
  | { readonly _tag: "ContextAborted" };

/**
 * Only Analysis reads `review-input.md`, where the stated goal goes: the
 * Change intent, or a pull request's description. An Analysis start names the
 * Review's intent and gets a pack that holds exactly its goal; Brief and
 * Walkthrough accept a pack whatever goal it holds, so their starts never
 * rewrite the file under a running Analysis.
 */
export type PackChangeIntent =
  | { readonly _tag: "Unread" }
  | { readonly _tag: "Read"; readonly intent: ChangeIntent | undefined }
  | {
      readonly _tag: "Captured";
      readonly resolved: ResolvedChangeIntent | undefined;
    };

/**
 * Reads only what decides whether a pack on disk still describes this
 * session's patch. Everything else in `context.json` is advisory model input,
 * so `looseObject` accepts a pack written by an older build as long as it
 * still names a patch hash.
 */
const packIdentitySchema = v.looseObject({
  patch: v.looseObject({ sha256: v.string() }),
});

/**
 * Builds `context.json`, `review-input.md`, and `debug.json` on first Insight
 * use, avoiding comment, check, and repository-rule reads for Reviews without
 * a run. Pull request evidence is read when building the pack; local Reviews
 * carry no comments or checks and make no GitHub read (ADR 0050).
 * An interrupted pack fails `isUsable` and is rebuilt without a journal.
 */
export class ReviewContextPackService {
  constructor(
    private readonly dependencies: {
      readonly profiles: Pick<ProfileStore, "load">;
      readonly github: Pick<
        GitHubReader,
        "getPullRequestComments" | "getPullRequestChecks"
      >;
      readonly context: ReviewContextService;
      readonly paths: PatchdeskPaths;
      /** Reads a spec-file Change intent from the session's head commit. */
      readonly git: GitReadExecutor;
    },
  ) {}

  /**
   * Leaves a usable pack alone and builds one otherwise. Callers must
   * serialize this per Review; `InsightRunCoordinator.startUnlocked` runs it
   * under `withReviewLock`, so two runs starting together cannot build twice
   * or read a half-written pack.
   */
  async ensure(input: {
    readonly session: ReviewSession;
    readonly patchHash: ContentHash;
    readonly changeIntent: PackChangeIntent;
  }): Promise<
    Result<
      { readonly changeIntent?: ChangeIntentProvenance },
      ReviewContextPackFailure
    >
  > {
    const { profileId } = input.session.key;
    const sessionId = input.session.id;
    const resolved = await this.resolve(input.session, input.changeIntent);
    if (resolved._tag === "err") return resolved;
    const provenance = ok(
      definedProps({
        changeIntent:
          resolved.value === undefined
            ? undefined
            : changeIntentProvenance(resolved.value),
      }),
    );
    const statedGoal =
      input.changeIntent._tag === "Unread"
        ? undefined
        : this.statedGoal(input.session, resolved.value);
    if (
      await this.isUsable(
        input.session,
        input.patchHash,
        input.changeIntent._tag === "Unread"
          ? { _tag: "Unread" }
          : {
              _tag: "Read",
              section:
                statedGoal === undefined
                  ? undefined
                  : renderStatedGoalSection(statedGoal),
            },
      )
    )
      return provenance;
    const profile = await this.dependencies.profiles.load(profileId);
    if (profile._tag === "err") return err({ _tag: "ContextPackUnavailable" });
    const patch = await readFile(input.session.patchPath, "utf8").catch(
      () => undefined,
    );
    if (patch === undefined) return err({ _tag: "ContextPackUnavailable" });
    const pullRequestEvidence = isPullRequestReviewSession(input.session)
      ? await this.readPullRequestEvidence(profile.value, input.session)
      : ok(undefined);
    if (pullRequestEvidence._tag === "err") return pullRequestEvidence;
    const built = await this.dependencies.context.prepare({
      worktreePath: input.session.worktree.path,
      preparedDirectory: this.dependencies.paths.preparedDirectory(
        profileId,
        sessionId,
      ),
      pr: {
        repository: `${input.session.key.owner}/${input.session.key.repo}`,
        source: reviewSourceTitle(input.session.key.source),
        headSha: input.session.key.headSha,
      },
      ...definedProps({
        comments: pullRequestEvidence.value?.comments,
        checks: pullRequestEvidence.value?.checks,
        statedGoal,
      }),
      changedFiles: changedPatchFiles(patch),
      patch: { path: input.session.patchPath, sha256: input.patchHash },
      rulePaths: profile.value.rulePaths,
    });
    return built._tag === "ok"
      ? provenance
      : err({ _tag: "ContextPackUnavailable" });
  }

  /**
   * Context for one Guide run: reads what `ensure` reads, minus the stated goal and Change intent, and writes nothing
   * under the session. A configured rule, or an optional rule file that exists but cannot be used, fails the capture
   * instead of becoming an omission; the shared pack keeps its older tolerance. No aggregate byte limit applies.
   * Pull request comments and checks are read without proof that the adapter returned every page, so their upstream
   * completeness is unknown; a local Review has none to omit. The GitHub reads cannot be aborted: the signal is checked
   * between them and the caller joins whatever began.
   */
  async captureRunContext(
    session: ReviewSession,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<
    Result<
      {
        readonly material: ReviewContextMaterial;
        readonly upstream: GuideUpstreamCompleteness;
      },
      GuideContextFailure
    >
  > {
    const aborted = err({ _tag: "ContextAborted" } as const);
    if (options.signal?.aborted) return aborted;
    const profile = await this.dependencies.profiles.load(
      session.key.profileId,
    );
    if (profile._tag === "err") return err({ _tag: "ContextPackUnavailable" });
    if (options.signal?.aborted) return aborted;
    const evidence = isPullRequestReviewSession(session)
      ? await this.readPullRequestEvidence(profile.value, session)
      : ok(undefined);
    if (evidence._tag === "err") return evidence;
    if (options.signal?.aborted) return aborted;
    const pr = {
      repository: `${session.key.owner}/${session.key.repo}`,
      source: reviewSourceTitle(session.key.source),
      headSha: session.key.headSha,
    };
    if (
      containsSensitiveData({
        pr,
        comments: evidence.value?.comments,
        checks: evidence.value?.checks,
      })
    )
      return err({ _tag: "ContextPackUnavailable" });
    const material = await this.dependencies.context.acquire(
      {
        worktreePath: session.worktree.path,
        pr,
        ...definedProps({
          comments: evidence.value?.comments,
          checks: evidence.value?.checks,
        }),
        rulePaths: profile.value.rulePaths,
      },
      { aggregate: "none", ...definedProps({ signal: options.signal }) },
    );
    if (options.signal?.aborted) return aborted;
    if (material.ruleLoadFailureCount > 0)
      return err({ _tag: "RequiredContextUnavailable" });
    return ok({
      material,
      upstream: evidence.value === undefined ? "complete" : "unknown",
    });
  }

  /** Uses the same captured-blob limits as Analysis preparation, under the caller's Review lock. */
  captureChangedHeadFiles(
    session: ReviewSession,
    context: string,
    onSkipped?: (path: string, reason: string) => void,
  ): Promise<Readonly<Record<string, string>>> {
    return captureModelReviewSnapshots({
      worktreePath: session.worktree.path,
      headSha: session.key.headSha,
      context,
      onSkipped,
      gitShow: async (argv) => {
        const result = await this.dependencies.git.run(argv);
        if (result._tag === "err")
          throw new Error("Captured snapshot unavailable");
        return result.value.stdout;
      },
    });
  }

  /** Resolves pinned intent before admission, without constructing or rewriting a pack. */
  async resolve(
    session: ReviewSession,
    changeIntent: PackChangeIntent,
  ): Promise<
    Result<ResolvedChangeIntent | undefined, ReviewContextPackFailure>
  > {
    if (changeIntent._tag === "Captured") return ok(changeIntent.resolved);
    if (changeIntent._tag === "Unread" || changeIntent.intent === undefined)
      return ok(undefined);
    const resolved = await resolveChangeIntent(
      this.dependencies.git,
      session,
      changeIntent.intent,
    );
    if (resolved._tag === "ok") return resolved;
    return err(
      resolved.error._tag === "ChangeIntentUnreadable"
        ? resolved.error
        : { _tag: "ContextPackUnavailable" },
    );
  }

  /** A local Review's goal is its Change intent; a pull request's is its description, as read at prepare. */
  private statedGoal(
    session: ReviewSession,
    changeIntent: ResolvedChangeIntent | undefined,
  ): StatedGoal | undefined {
    if (changeIntent !== undefined)
      return { kind: "change_intent", resolved: changeIntent };
    const description = isPullRequestReviewSession(session)
      ? session.prContext?.description
      : undefined;
    return description === undefined || description.trim() === ""
      ? undefined
      : { kind: "pull_request_description", markdown: description };
  }

  /** The comments and checks a pull request pack carries; either read failing fails the pack. */
  private async readPullRequestEvidence(
    profile: WorkspaceProfileConfig,
    session: PullRequestReviewSession,
  ) {
    const pullRequest = {
      host: session.key.host,
      owner: session.key.owner,
      repo: session.key.repo,
      number: session.key.source.prNumber,
    };
    const [comments, checks] = await Promise.all([
      this.dependencies.github.getPullRequestComments({
        profile,
        pr: pullRequest,
      }),
      this.dependencies.github.getPullRequestChecks({
        profile,
        pr: pullRequest,
        headSha: session.key.headSha,
      }),
    ]);
    return comments._tag === "err" || checks._tag === "err"
      ? err({ _tag: "ContextPackUnavailable" } as const)
      : ok({ comments: comments.value, checks: checks.value });
  }

  /**
   * A pack is usable only when all three files are present and `context.json`
   * parses and names this session's current patch hash. A pack interrupted
   * mid-build fails one of those, and a pack left by an earlier revision
   * fails the hash. A `review-input.md` without the current heading predates
   * #495 and is rebuilt. For Analysis, it must also end with the section of
   * the stated goal, or hold none when there is none.
   */
  private async isUsable(
    session: ReviewSession,
    patchHash: ContentHash,
    changeIntent:
      | { readonly _tag: "Unread" }
      | { readonly _tag: "Read"; readonly section: string | undefined },
  ): Promise<boolean> {
    const { profileId } = session.key;
    const present = await Promise.all([
      exists(
        this.dependencies.paths.preparedReviewInputFile(profileId, session.id),
      ),
      exists(this.dependencies.paths.preparedDebugFile(profileId, session.id)),
    ]);
    if (present.includes(false)) return false;
    const stored = await readJsonFile(
      this.dependencies.paths.preparedContextFile(profileId, session.id),
    );
    if (stored._tag === "err") return false;
    const parsed = v.safeParse(packIdentitySchema, stored.value);
    if (!parsed.success || parsed.output.patch.sha256 !== patchHash)
      return false;
    const reviewInput = await readFile(
      this.dependencies.paths.preparedReviewInputFile(profileId, session.id),
      "utf8",
    ).catch(() => undefined);
    if (
      reviewInput === undefined ||
      !reviewInput.startsWith(REVIEW_INPUT_HEADING)
    )
      return false;
    if (changeIntent._tag === "Unread") return true;
    // The header lines hold no heading, so the first one starts the goal section.
    const start = reviewInput.indexOf("\n## ");
    const section = start < 0 ? undefined : reviewInput.slice(start + 1);
    return section === changeIntent.section;
  }
}
