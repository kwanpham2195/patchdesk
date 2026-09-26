import { readFile } from "node:fs/promises";

import * as v from "valibot";

import type { GitHubReader } from "../adapters/github/github-adapter";
import { readJsonFile } from "../adapters/storage/json-file";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ProfileStore } from "../adapters/storage/profile-store";
import {
  changeIntentProvenance,
  type ChangeIntent,
  type ChangeIntentProvenance,
  type ResolvedChangeIntent,
} from "../domain/change-intent";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import { definedProps } from "../domain/defined-props";
import type { ContentHash } from "../domain/ids";
import { err, ok, type Result } from "../domain/result";
import { reviewSourceTitle } from "../domain/review-source";
import {
  isPullRequestReviewSession,
  type PullRequestReviewSession,
  type ReviewSession,
} from "../domain/review-session";
import {
  renderStatedGoalSection,
  type StatedGoal,
} from "../domain/stated-goal";
import { tokenizeUnifiedPatch } from "../domain/unified-patch";
import {
  resolveChangeIntent,
  type ChangeIntentUnreadable,
} from "./change-intent-resolution";
import {
  REVIEW_INPUT_HEADING,
  type ReviewContextService,
} from "./review-context-service";
import { exists } from "./review-preparation-journal";
import type { GitReadExecutor } from "./review-worktree-service";

export type ReviewContextPackFailure =
  | { readonly _tag: "ContextPackUnavailable" }
  | ChangeIntentUnreadable;

/**
 * Only Analysis reads `review-input.md`, where the stated goal goes: the
 * Change intent, or a pull request's description. An Analysis start names the
 * Review's intent and gets a pack that holds exactly its goal; Brief and
 * Walkthrough accept a pack whatever goal it holds, so their starts never
 * rewrite the file under a running Analysis.
 */
export type PackChangeIntent =
  | { readonly _tag: "Unread" }
  | { readonly _tag: "Read"; readonly intent: ChangeIntent | undefined };

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
 * Builds the Insight context pack (`context.json`, `review-input.md`,
 * `debug.json`) on first use rather than at prepare. Opening a Review no
 * longer pays for comments, checks, and a repository rule sweep the
 * maintainer may never run an Insight against.
 *
 * The pack describes the pull request as of the Insight run, not as of
 * prepare. A local Review has no pull request, so its pack carries no
 * comments or checks and makes no GitHub read (ADR 0050). Crash safety needs
 * no journal: a half-written pack fails `isUsable` and is rebuilt from scratch.
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
      changedFiles: changedFiles(patch),
      patch: { path: input.session.patchPath, sha256: input.patchHash },
      rulePaths: profile.value.rulePaths,
    });
    return built._tag === "ok"
      ? provenance
      : err({ _tag: "ContextPackUnavailable" });
  }

  private async resolve(
    session: ReviewSession,
    changeIntent: PackChangeIntent,
  ): Promise<
    Result<ResolvedChangeIntent | undefined, ReviewContextPackFailure>
  > {
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
