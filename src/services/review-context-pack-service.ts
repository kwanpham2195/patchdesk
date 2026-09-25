import { readFile } from "node:fs/promises";

import * as v from "valibot";

import type { GitHubReader } from "../adapters/github/github-adapter";
import { readJsonFile } from "../adapters/storage/json-file";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import { definedProps } from "../domain/defined-props";
import type { ContentHash } from "../domain/ids";
import { casesHandled, err, ok, type Result } from "../domain/result";
import {
  isPullRequestReviewSession,
  type PullRequestReviewSession,
  type ReviewSession,
} from "../domain/review-session";
import { tokenizeUnifiedPatch } from "../domain/unified-patch";
import type { ReviewContextService } from "./review-context-service";
import { exists } from "./review-preparation-journal";

export type ReviewContextPackFailure = {
  readonly _tag: "ContextPackUnavailable";
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
  }): Promise<Result<void, ReviewContextPackFailure>> {
    const { profileId } = input.session.key;
    const sessionId = input.session.id;
    if (await this.isUsable(input.session, input.patchHash))
      return ok(undefined);
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
        title: reviewSourceTitle(input.session),
        headSha: input.session.key.headSha,
      },
      ...definedProps({
        comments: pullRequestEvidence.value?.comments,
        checks: pullRequestEvidence.value?.checks,
      }),
      changedFiles: changedFiles(patch),
      patch: { path: input.session.patchPath, sha256: input.patchHash },
      rulePaths: profile.value.rulePaths,
    });
    return built._tag === "ok"
      ? ok(undefined)
      : err({ _tag: "ContextPackUnavailable" });
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
   * fails the hash.
   */
  private async isUsable(
    session: ReviewSession,
    patchHash: ContentHash,
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
    return parsed.success && parsed.output.patch.sha256 === patchHash;
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

/** Names the Review source in the pack, since a local Review has no pull request title. */
function reviewSourceTitle(session: ReviewSession): string {
  const repository = `${session.key.owner}/${session.key.repo}`;
  const source = session.key.source;
  switch (source.kind) {
    case "pull_request":
      return `${repository}#${source.prNumber}`;
    case "working_tree":
      return `${repository} working tree on ${source.branch ?? "detached HEAD"}`;
    case "branch":
      return `${repository} branch ${source.branch} against ${source.baseBranch}`;
    case "commit":
      return `${repository} commit ${source.commitSha}`;
    default:
      return casesHandled(source);
  }
}
