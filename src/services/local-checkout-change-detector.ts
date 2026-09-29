import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ProfileStore } from "../adapters/storage/profile-store";
import type { ReviewSessionStore } from "../adapters/storage/review-session-store";
import {
  detachedHeadBranch,
  parseGitSha,
  type ContentHash,
  type GitSha,
} from "../domain/ids";
import type { Review } from "../domain/review";
import { isPullRequestReviewSession } from "../domain/review-session";
import type { LocalReviewSource } from "../domain/review-source";
import type { AppLogService } from "./app-log-service";
import {
  fingerprintLocalCheckout,
  withoutOptionalLocks,
} from "./local-checkout-fingerprint";
import { resolveLocalReviewCheckout } from "./local-checkout";
import type { GitReadExecutor } from "./review-worktree-service";

type LocalCheckoutChangeDependencies = {
  readonly git: GitReadExecutor;
  readonly paths: Pick<PatchdeskPaths, "cacheDirectory">;
  readonly profiles: Pick<ProfileStore, "load">;
  readonly sessions: Pick<ReviewSessionStore, "load">;
  readonly logs?: Pick<AppLogService, "write">;
};

/**
 * The update check for a shared local Review (#611, ADR 0050 "Freshness"):
 * compares the checkout's read-only fingerprint with the one its current
 * session recorded. It records nothing and never moves the Review; Refresh
 * does that.
 */
export class LocalCheckoutChangeDetector {
  private readonly git: GitReadExecutor;
  /** Fingerprints first read for sessions stored before #611, which recorded none; kept in this process only. */
  private readonly firstReadFingerprints = new Map<string, ContentHash>();
  /** Reviews whose failed read was logged; cleared by the next read that succeeds. */
  private readonly loggedFailures = new Set<string>();

  constructor(private readonly dependencies: LocalCheckoutChangeDependencies) {
    this.git = withoutOptionalLocks(dependencies.git);
  }

  /**
   * True when the checkout no longer matches the Review's current session.
   * False for a Commit Review, whose commit cannot change, for a checkout on
   * another branch, which Refresh refuses, and for a failed read, which is
   * logged once per Review.
   */
  async checkoutChanged(review: Review<LocalReviewSource>): Promise<boolean> {
    const { identity } = review;
    const { source, profileId } = identity;
    if (source.kind !== "local_branch") return false;
    const reviewKey = `${profileId}:${review.id}`;
    const failed = (cause: string): false => {
      if (!this.loggedFailures.has(reviewKey))
        this.dependencies.logs?.write({
          process: "main",
          level: "warn",
          topic: "local-review-updates",
          message:
            "reading a local Review's checkout for updates failed; answered Unchanged",
          profileId,
          meta: { reviewId: review.id, cause },
        });
      this.loggedFailures.add(reviewKey);
      return false;
    };
    const [profile, session] = await Promise.all([
      this.dependencies.profiles.load(profileId),
      this.dependencies.sessions.load(profileId, review.currentSessionId),
    ]);
    if (profile._tag === "err") return failed("profile_unreadable");
    if (session._tag === "err" || isPullRequestReviewSession(session.value))
      return failed("session_unreadable");
    const checkout = await resolveLocalReviewCheckout(
      { git: this.git, paths: this.dependencies.paths },
      profile.value,
      identity,
      source.checkout,
    );
    if (checkout._tag === "err") return failed(checkout.error._tag);
    const { checkoutPath } = checkout.value;
    const headSha = await this.readSha(checkoutPath, "HEAD^{commit}");
    if (headSha === undefined) return failed("head_unreadable");
    const branch = await this.git.run([
      "git",
      "-C",
      checkoutPath,
      "symbolic-ref",
      "-q",
      "--short",
      "HEAD",
    ]);
    const onBranch =
      branch._tag === "ok" ? branch.value.stdout.trim() : detachedHeadBranch;
    if (onBranch !== source.branch) {
      this.loggedFailures.delete(reviewKey);
      return false;
    }
    const baseTip = await this.readSha(
      checkoutPath,
      `${source.baseRef}^{commit}`,
    );
    const mergeBase =
      baseTip === undefined
        ? undefined
        : parseGitShaOrUndefined(
            await this.git.run([
              "git",
              "-C",
              checkoutPath,
              "merge-base",
              "--end-of-options",
              baseTip,
              headSha,
            ]),
          );
    if (mergeBase === undefined) return failed("merge_base_unreadable");
    const fingerprint = await fingerprintLocalCheckout(
      this.dependencies.git,
      checkoutPath,
      { headSha, mergeBase },
    );
    if (fingerprint === undefined) return failed("fingerprint_unreadable");
    this.loggedFailures.delete(reviewKey);
    const sessionKey = `${profileId}:${session.value.id}`;
    const recorded =
      session.value.checkoutFingerprint ??
      this.firstReadFingerprints.get(sessionKey);
    if (recorded === undefined) {
      this.firstReadFingerprints.set(sessionKey, fingerprint);
      return false;
    }
    return fingerprint !== recorded;
  }

  private async readSha(
    checkoutPath: string,
    revision: string,
  ): Promise<GitSha | undefined> {
    return parseGitShaOrUndefined(
      await this.git.run([
        "git",
        "-C",
        checkoutPath,
        "rev-parse",
        "--verify",
        revision,
      ]),
    );
  }
}

function parseGitShaOrUndefined(
  read: Awaited<ReturnType<GitReadExecutor["run"]>>,
): GitSha | undefined {
  if (read._tag === "err") return undefined;
  const parsed = parseGitSha(read.value.stdout.trim());
  return parsed._tag === "ok" ? parsed.value : undefined;
}
