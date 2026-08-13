import { readFile } from "node:fs/promises";

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
    const sessionPatchHash = await this.sessionPatchHash(input.session);
    if (sessionPatchHash === undefined) {
      return ok({ _tag: "Unavailable", reason: "reconciliation_incomplete" });
    }
    const same =
      input.session.key.headSha === identity.headSha &&
      input.session.pr.baseSha === identity.baseSha &&
      sessionPatchHash === identity.canonicalPatchHash;
    return ok(
      same ? { _tag: "Same", identity } : { _tag: "Changed", identity },
    );
  }

  private async sessionPatchHash(session: ReviewSession) {
    const patch = await readFile(session.patchPath, "utf8").catch(
      () => undefined,
    );
    if (patch === undefined) return undefined;
    const hash = parseContentHash(
      hashReviewArtifactContent(normalizeReviewPatch(patch)),
    );
    return hash._tag === "ok" ? hash.value : undefined;
  }
}

function countChangedFiles(patch: string): number {
  return patch.split("\n").filter((line) => line.startsWith("diff --git "))
    .length;
}
