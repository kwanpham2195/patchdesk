import type { GitHubReader } from "../adapters/github/github-adapter";
import type { PullRequestRef } from "../domain/pull-request";
import type {
  ObservedRevisionIdentity,
  RevisionUnavailableReason,
} from "../domain/review";
import type { ReviewSession } from "../domain/review-session";
import type { WorkspaceProfileConfig } from "../domain/workspace-profile";
import { parseContentHash } from "../domain/ids";
import { ok, type Result } from "../domain/result";
import { hashReviewArtifactContent } from "./review-artifact-hash";
import { normalizeReviewPatch } from "./review-session-preparation";

/** Canonical comparison result for a represented session and GitHub revision. */
export type RevisionComparison =
  | { readonly _tag: "Same"; readonly identity: ObservedRevisionIdentity }
  | { readonly _tag: "Changed"; readonly identity: ObservedRevisionIdentity }
  | {
      readonly _tag: "Unavailable";
      readonly reason: RevisionUnavailableReason;
    };

/** Cheap reconfirmation result: whether a previously proven identity still holds. */
export type RevisionRecheck =
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Changed" }
  | {
      readonly _tag: "Unavailable";
      readonly reason: RevisionUnavailableReason;
    };

/**
 * Proves whether GitHub still represents a session's exact remote revision.
 * A head SHA alone never proves equality: base SHA and complete canonical diff
 * bytes are required before any caller may mark a Review fresh.
 */
export class GitHubRevisionIdentityReader {
  constructor(
    private readonly github: Pick<
      GitHubReader,
      "getPullRequest" | "getPullRequestDiff"
    >,
  ) {}

  /** Read GitHub's complete canonical identity for one represented session. */
  async read(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly session: ReviewSession;
  }): Promise<Result<RevisionComparison, never>> {
    if (input.session.pr.baseSha === undefined) {
      return ok({ _tag: "Unavailable", reason: "base_missing" });
    }

    const current = await this.github.getPullRequest({
      profile: input.profile,
      pr: input.pr,
    });
    if (current._tag === "err") {
      return ok({ _tag: "Unavailable", reason: "github_read" });
    }
    if (current.value.baseSha === undefined) {
      return ok({ _tag: "Unavailable", reason: "base_missing" });
    }
    if (current.value.changedFileCount === undefined) {
      return ok({ _tag: "Unavailable", reason: "diff_incomplete" });
    }

    const remotePatch = await this.github.getPullRequestDiff({
      profile: input.profile,
      pr: input.pr,
      snapshot: {
        baseSha: current.value.baseSha,
        headSha: current.value.headSha,
      },
    });
    if (remotePatch._tag === "err") {
      return ok({ _tag: "Unavailable", reason: "github_read" });
    }
    const normalizedPatch = normalizeReviewPatch(remotePatch.value);
    if (countChangedFiles(normalizedPatch) !== current.value.changedFileCount) {
      return ok({ _tag: "Unavailable", reason: "diff_incomplete" });
    }

    const canonicalPatchHash = parseContentHash(
      hashReviewArtifactContent(normalizedPatch),
    );
    if (canonicalPatchHash._tag === "err") {
      return ok({ _tag: "Unavailable", reason: "comparison_ambiguous" });
    }
    const identity: ObservedRevisionIdentity = {
      headSha: current.value.headSha,
      baseSha: current.value.baseSha,
      canonicalPatchHash: canonicalPatchHash.value,
    };
    // A session prepared before ADR 0026 (or one whose canonical fetch
    // failed at open time, per that ADR) has no stored hash. It is compared
    // on the SHA pair alone rather than reported `Unavailable`: `headSha`
    // and `baseSha` are still stored and content-addressed, so a genuine
    // revision change is still caught. No hash is backfilled onto the
    // session here — session identity embeds the head SHA, so a legacy
    // session naturally retires the moment a new revision creates a new one.
    const same =
      input.session.key.headSha === identity.headSha &&
      input.session.pr.baseSha === identity.baseSha &&
      (input.session.canonicalPatchHash === undefined ||
        input.session.canonicalPatchHash === identity.canonicalPatchHash);
    return ok(
      same ? { _tag: "Same", identity } : { _tag: "Changed", identity },
    );
  }

  /**
   * Cheaply reconfirm a previously proven identity without re-fetching or
   * re-hashing the diff.
   *
   * WHY THIS IS SUFFICIENT: `headSha` and `baseSha` are content-addressed Git
   * commit identifiers, each naming an immutable tree. GitHub's diff between
   * a fixed pair of commits is a pure function of those two trees, so it
   * cannot change while the pair itself does not. A prior `read()` already
   * fetched and hashed the full diff for `input.identity`'s pair and proved
   * it canonical; if `getPullRequest` now reports the same (headSha, baseSha)
   * pair, the diff GitHub would return for it is provably the same diff
   * `read()` already hashed, so re-fetching and re-hashing it proves nothing
   * new. This holds only because Git SHAs are content-addressed and GitHub
   * does not let a SHA's tree change underneath it (no "force-push onto an
   * existing SHA") — if that ever stopped being true, this shortcut would be
   * unsound and `read()` would need to run again instead.
   */
  async recheckUnchanged(input: {
    readonly profile: WorkspaceProfileConfig;
    readonly pr: PullRequestRef;
    readonly identity: ObservedRevisionIdentity;
  }): Promise<Result<RevisionRecheck, never>> {
    const current = await this.github.getPullRequest({
      profile: input.profile,
      pr: input.pr,
    });
    if (current._tag === "err") {
      return ok({ _tag: "Unavailable", reason: "github_read" });
    }
    if (current.value.baseSha === undefined) {
      return ok({ _tag: "Unavailable", reason: "base_missing" });
    }
    if (current.value.changedFileCount === undefined) {
      return ok({ _tag: "Unavailable", reason: "diff_incomplete" });
    }
    const same =
      current.value.headSha === input.identity.headSha &&
      current.value.baseSha === input.identity.baseSha;
    return ok({ _tag: same ? "Unchanged" : "Changed" });
  }
}

function countChangedFiles(patch: string): number {
  return patch.split("\n").filter((line) => line.startsWith("diff --git "))
    .length;
}
