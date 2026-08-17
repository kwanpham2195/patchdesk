import type { CommandFailure } from "./command-runner";
import type { GitHubWriteFailure } from "../../domain/github-write";
import { err, type Result } from "../../domain/result";
import type { GitHubReadFailure, GitHubReadOperation } from "./github-adapter";

export function optionalPolicyUnavailableReason(
  failure: CommandFailure,
): "forbidden" | "not_found" | "unsupported" | undefined {
  if (failure._tag === "CommandForbidden") return "forbidden";
  if (failure._tag === "CommandNotFound") return "not_found";
  if (failure._tag === "CommandUnsupported") return "unsupported";
  return undefined;
}

export function writeFailure(failure: CommandFailure): GitHubWriteFailure {
  if (failure._tag === "CommandAuthenticationRequired")
    return {
      _tag: "GitHubWriteFailure",
      category: "auth",
      message: "GitHub authentication is required.",
    };
  if (failure._tag === "CommandPendingReview")
    return {
      _tag: "GitHubWriteFailure",
      category: "pending_review",
      message:
        "You have an unfinished review on this pull request on GitHub; submit or discard it before commenting.",
    };
  if (failure._tag === "CommandRateLimited")
    return {
      _tag: "GitHubWriteFailure",
      category: "rate_limited",
      message: "GitHub rate-limited this request.",
    };
  if (failure._tag === "CommandFailed")
    return {
      _tag: "GitHubWriteFailure",
      category: "rejected",
      message: "GitHub rejected the review request.",
    };
  return {
    _tag: "GitHubWriteFailure",
    category: "unavailable",
    message: "GitHub review request could not be confirmed.",
  };
}

export function directSummaryWriteFailure(
  failure: CommandFailure,
): GitHubWriteFailure {
  if (failure._tag === "CommandFailed") {
    return {
      _tag: "GitHubWriteFailure",
      category: "unavailable",
      message: "GitHub review request could not be confirmed.",
    };
  }
  return writeFailure(failure);
}

export function invalid(
  operation: GitHubReadOperation,
): Result<never, GitHubReadFailure> {
  return err({ _tag: "GitHubResponseInvalid", operation });
}

export function missing(
  operation: GitHubReadOperation,
): Result<never, GitHubReadFailure> {
  return err({ _tag: "GitHubReadFailed", operation });
}
