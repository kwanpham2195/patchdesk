import type { ForbiddenReason } from "./github-forbidden-reason";

/**
 * Safe error returned by a current GitHub write. `reason` is present only
 * when `category` is `"forbidden"`; it carries the same closed
 * `ForbiddenReason` enum the read path uses (see plan 009's
 * `docs/adr/0024-explain-forbidden-github-reads.md`), never GitHub's raw
 * message text.
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
};
