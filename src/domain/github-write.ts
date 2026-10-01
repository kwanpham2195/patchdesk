import type { ForbiddenReason } from "./github-forbidden-reason";

/**
 * Why GitHub refused a merge request: `head_changed` for 409, `not_mergeable`
 * for 405 (the merge cannot be performed) and 422 (validation failed).
 */
export type GitHubMergeRefusal = "not_mergeable" | "head_changed";

/**
 * Safe error returned by a current GitHub write. `reason` is present only
 * when `category` is `"forbidden"`; it carries the same closed
 * `ForbiddenReason` enum the read path uses (see plan 009's
 * `docs/adr/0024-explain-forbidden-github-reads.md`), never GitHub's raw
 * message text. `refusal` is present only on a merge's `"rejected"` failure.
 */
export type GitHubWriteFailure = {
  readonly _tag: "GitHubWriteFailure";
  readonly category:
    | "auth"
    | "rejected"
    | "unavailable"
    | "pending_review"
    | "rate_limited"
    | "forbidden";
  readonly message: string;
  readonly reason?: ForbiddenReason;
  readonly refusal?: GitHubMergeRefusal;
};
