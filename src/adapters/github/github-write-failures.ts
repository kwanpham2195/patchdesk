import type { CommandFailure } from "./command-runner";
import type { ForbiddenReason } from "../../domain/github-forbidden-reason";
import type { GitHubWriteFailure } from "../../domain/github-write";
import type { RefusalCause } from "../../domain/github-write-refusal";
import { err, type Result } from "../../domain/result";
import type { GitHubReadFailure, GitHubReadOperation } from "./github-adapter";

export function optionalPolicyUnavailableReason(
  failure: CommandFailure,
): "forbidden" | "not_found" | "unsupported" | undefined {
  if (failure._tag === "CommandForbidden") return "forbidden";
  if (failure._tag === "CommandNotFound") return "not_found";
  if (
    failure._tag === "CommandUnsupported" ||
    failure._tag === "CommandMethodNotAllowed" ||
    failure._tag === "CommandUnprocessable"
  )
    return "unsupported";
  return undefined;
}

/**
 * A status that means refusal earns the `refused` category with its cause; the
 * write service decides whether that refusal is final for its write
 * (`refusalFinality`, issue #755). Everything else keeps the Review locked for
 * reconciliation, because the mutation may already have landed (ADR 0035,
 * issue #288). `CommandFailed` carries no status, so it is never a refusal
 * here.
 */
export function writeFailure(failure: CommandFailure): GitHubWriteFailure {
  if (failure._tag === "CommandAuthenticationRequired")
    return {
      _tag: "GitHubWriteFailure",
      category: "auth",
      message: "GitHub authentication is required.",
    };
  if (failure._tag === "CommandForbidden")
    return {
      _tag: "GitHubWriteFailure",
      category: "forbidden",
      message: forbiddenWriteMessage(failure.reason),
      reason: failure.reason,
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
  const cause = refusalCause(failure);
  if (cause !== undefined)
    return {
      _tag: "GitHubWriteFailure",
      category: "refused",
      message: "GitHub refused the request.",
      cause,
    };
  return {
    _tag: "GitHubWriteFailure",
    category: "unavailable",
    message: "GitHub review request could not be confirmed.",
  };
}

/** The cause of a status GitHub answers with a definite refusal; undefined for every failure that may have landed. */
function refusalCause(failure: CommandFailure): RefusalCause | undefined {
  switch (failure._tag) {
    case "CommandNotFound":
      return "not_found";
    case "CommandConflict":
      return "conflict";
    case "CommandMethodNotAllowed":
      return "not_allowed";
    case "CommandUnprocessable":
      return "unprocessable";
    case "CommandUnsupported":
      return "unsupported";
    default:
      return undefined;
  }
}

/**
 * Reason-scoped copy for a forbidden write, mirroring
 * `inbox-flow.tsx`'s `forbiddenCopy()` on the read side: names the
 * blocking condition, never implies a retry will help, and never repeats
 * GitHub's raw message text. Unlike the read side, no repo/org name is
 * available at this layer, so the copy stays generic about "this
 * organization" rather than naming it.
 */
function forbiddenWriteMessage(reason: ForbiddenReason): string {
  switch (reason) {
    case "ip_allow_list":
      return "GitHub blocked this write: this organization has an IP allow list enabled and this network is not on it.";
    case "saml":
      return "GitHub blocked this write: this organization requires SAML single sign-on authorization for this account's token.";
    case "insufficient_scopes":
      return "GitHub blocked this write: this account's token does not have the scopes this organization requires.";
    case "unknown":
      return "GitHub blocked this write and did not say why. This is not necessarily temporary — check the repository's or organization's access settings on GitHub.";
  }
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
