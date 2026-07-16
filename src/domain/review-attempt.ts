import type {
  AbsolutePath,
  ContentHash,
  IsoTimestamp,
  ReviewAttemptId,
  ReviewSessionId,
} from "./ids";

export type ReviewFailureSummary = {
  readonly category:
    | "github_auth"
    | "github_read"
    | "git_worktree"
    | "context"
    | "flue"
    | "parsing"
    | "stale_head"
    | "storage"
    | "policy"
    | "unknown";
  readonly message: string;
};

export type ReviewAttemptState =
  | { readonly _tag: "Running"; readonly flueRunId: string }
  | { readonly _tag: "Completed"; readonly resultPath: AbsolutePath }
  | { readonly _tag: "Failed"; readonly error: ReviewFailureSummary }
  | { readonly _tag: "Discarded"; readonly discardedAt: IsoTimestamp }
  | {
      readonly _tag: "IgnoredLateResult";
      readonly completedAt: IsoTimestamp;
      readonly reason: "not_current" | "session_discarded";
    };

export type ReviewAttempt = {
  readonly id: ReviewAttemptId;
  readonly sessionId: ReviewSessionId;
  readonly state: ReviewAttemptState;
  readonly flueRunId?: string;
  readonly model: string;
  readonly patchdeskVersion?: string;
  readonly reviewSkillVersion: ContentHash;
  readonly contextHash: ContentHash;
  readonly contextPath: AbsolutePath;
  readonly reviewInputPath: AbsolutePath;
  readonly resultPath?: AbsolutePath;
  readonly debugPath: AbsolutePath;
  readonly startedAt: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
};
