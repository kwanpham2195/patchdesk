/** Safe error returned by a current GitHub write. */
export type GitHubWriteFailure = {
  readonly _tag: "GitHubWriteFailure";
  readonly category:
    | "auth"
    | "rejected"
    | "unavailable"
    | "pending_review"
    | "rate_limited";
  readonly message: string;
};
