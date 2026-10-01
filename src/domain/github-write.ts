import type { ForbiddenReason } from "./github-forbidden-reason";
import type { RefusalCause } from "./github-write-refusal";

type GitHubWriteFailureFields = {
  readonly _tag: "GitHubWriteFailure";
  readonly message: string;
  readonly reason?: ForbiddenReason;
};

/**
 * Safe error returned by a current GitHub write. `reason` is present only
 * when `category` is `"forbidden"`; it carries the same closed
 * `ForbiddenReason` enum the read path uses (see plan 009's
 * `docs/adr/0024-explain-forbidden-github-reads.md`), never GitHub's raw
 * message text. `"refused"` is GitHub's definite answer that it did not do
 * the write and always carries its `cause`; whether that is final depends on
 * the write kind (`refusalFinality`).
 */
export type GitHubWriteFailure = GitHubWriteFailureFields &
  (
    | {
        readonly category:
          | "auth"
          | "rejected"
          | "unavailable"
          | "pending_review"
          | "rate_limited"
          | "forbidden";
      }
    | { readonly category: "refused"; readonly cause: RefusalCause }
  );
