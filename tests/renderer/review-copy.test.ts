import { describe, expect, it } from "vitest";

import {
  PatchdeskApiError,
  contextualMessage,
  isOutcomeUnknownRetry,
  type ApiFailureKind,
} from "../../src/renderer/src/api-client";
import {
  DIRECT_SUMMARY_MESSAGES,
  FINISH_REVIEW_MESSAGES,
  PENDING_REVIEW_RECOVERY_MESSAGES,
  cleanupCopy,
} from "../../src/renderer/src/review-copy";

describe("review copy contract", () => {
  it("defines exact cleanup retention copy", () => {
    expect(cleanupCopy("clear_cache")).toEqual({
      title: "Clear cache?",
      body: "This removes rebuildable local files. Your saved reviews and diagnostic reports stay.",
      confirmLabel: "Clear cache",
    });
    expect(cleanupCopy("clear_local_review_data")).toEqual({
      title: "Clear local review data?",
      body: "This removes completed and failed local reviews. An active review and diagnostic reports stay.",
      confirmLabel: "Clear local data",
    });
  });
});

// The three review-write failure tables, exercised through the same
// `contextualMessage` the flows call. Every string a maintainer can see for a
// failed review write is pinned here; before this, most of them had no test
// at all.
describe("review write failure copy", () => {
  const apiError = (kind: ApiFailureKind): PatchdeskApiError =>
    new PatchdeskApiError(kind, 500, false, "test", "unused");

  it("words the Finish review dialog's own failure kinds", () => {
    const message = (kind: ApiFailureKind): string =>
      contextualMessage(apiError(kind), FINISH_REVIEW_MESSAGES);

    expect(message("outcome_unknown")).toBe(
      "GitHub could not confirm the submission. Check GitHub again before trying again.",
    );
    expect(message("ambiguous_write")).toBe(message("outcome_unknown"));
    expect(message("timeout")).toBe(message("outcome_unknown"));
    expect(message("invalid_input")).toBe(
      "The request contains invalid information. Check GitHub again or refresh.",
    );
    expect(message("unavailable")).toBe(
      "The requested service is currently unavailable. Check GitHub again or refresh.",
    );
    expect(message("pending_review")).toBe(
      "A pending review already exists. Refresh, then finish or discard that review before submitting a summary.",
    );
    expect(message("stale_head")).toBe(
      "The pull request changed. Refresh, then finish the review.",
    );
    expect(message("rejected")).toBe("GitHub rejected the submission.");
    expect(message("github_rejected")).toBe("GitHub rejected the submission.");
    expect(message("no_pending_review")).toBe(
      "The pending review changed. Check GitHub again or refresh.",
    );
    expect(message("pending_review_locked")).toBe(message("no_pending_review"));
    expect(message("forbidden")).toBe(
      "GitHub blocked this submission: the repository or organization restricts access here. Retrying will not help — check GitHub's access settings for this organization.",
    );
  });

  it("words the direct review summary's own failure kinds", () => {
    const message = (kind: ApiFailureKind): string =>
      contextualMessage(apiError(kind), DIRECT_SUMMARY_MESSAGES);

    expect(message("outcome_unknown")).toBe(
      "GitHub could not confirm the submission. Check GitHub again before trying again.",
    );
    expect(message("invalid_input")).toBe(
      "The request contains invalid information. Check GitHub again or refresh.",
    );
    expect(message("unavailable")).toBe(
      "The requested service is currently unavailable. Check GitHub again or refresh.",
    );
    expect(message("pending_review")).toBe(
      "A pending review already exists. Refresh, then finish or discard that review before submitting a summary.",
    );
    expect(message("stale_head")).toBe(
      "The pull request changed. Refresh before submitting a review summary.",
    );
    expect(message("rejected")).toBe("GitHub rejected the review summary.");
    expect(message("github_rejected")).toBe(
      "GitHub rejected the review summary.",
    );
    expect(message("forbidden")).toBe(
      "GitHub blocked this review summary: the repository or organization restricts access here. Retrying will not help — check GitHub's access settings for this organization.",
    );
  });

  it("words the Check GitHub again recovery's own failure kinds", () => {
    const message = (kind: ApiFailureKind): string =>
      contextualMessage(apiError(kind), PENDING_REVIEW_RECOVERY_MESSAGES);

    expect(message("review_write_in_progress")).toBe(
      "Another action is still finishing. Wait a moment, then check GitHub again.",
    );
    expect(message("timeout")).toBe(
      "Patchdesk could not check GitHub right now. Try again.",
    );
    expect(message("unavailable")).toBe(message("timeout"));
    expect(message("outcome_unknown")).toBe(message("timeout"));
    expect(message("invalid_input")).toBe(
      "Patchdesk could not check this pending review. Try again or refresh.",
    );
    expect(message("storage")).toBe(
      "Patchdesk could not read this review's local data. Try again or refresh.",
    );
  });

  // `github_rejected` reaches the recovery button from one code only:
  // `permission_denied`, which `pending-review-service.ts`'s `mapGateFailure`
  // returns when the local write gate answers `terminal` or `stale`. That
  // gate reads local stores, so GitHub is never asked — and the recovery
  // button is the one place a sentence must end with what to do next.
  it("does not blame GitHub when the recovery surface's own write gate refused", () => {
    const recovery = contextualMessage(
      apiError("github_rejected"),
      PENDING_REVIEW_RECOVERY_MESSAGES,
    );
    expect(recovery).toBe(
      "Patchdesk did not check GitHub: this review is closed, or Patchdesk's copy of it is out of date. Refresh, then check again.",
    );
    expect(recovery).not.toBe("GitHub rejected this action.");
    expect(recovery).not.toBe(
      contextualMessage(apiError("github_rejected"), FINISH_REVIEW_MESSAGES),
    );
  });

  it("keeps the two write surfaces apart where they must say different things", () => {
    const finish = (kind: ApiFailureKind): string =>
      contextualMessage(apiError(kind), FINISH_REVIEW_MESSAGES);
    const summary = (kind: ApiFailureKind): string =>
      contextualMessage(apiError(kind), DIRECT_SUMMARY_MESSAGES);

    for (const kind of ["stale_head", "rejected", "forbidden"] as const)
      expect(finish(kind)).not.toBe(summary(kind));
    // And together where they must not drift apart.
    for (const kind of [
      "outcome_unknown",
      "pending_review",
      "invalid_input",
      "unavailable",
    ] as const)
      expect(finish(kind)).toBe(summary(kind));
  });

  it("falls back to the API's own copy for a kind a surface does not word", () => {
    // `review_write_in_progress` and `self_approval_not_allowed` are not in
    // either table: the API already says exactly what these screens need.
    expect(
      contextualMessage(
        apiError("review_write_in_progress"),
        FINISH_REVIEW_MESSAGES,
      ),
    ).toBe(
      "Another action is still finishing. Your review was not submitted. Wait a moment, then submit again.",
    );
    expect(
      contextualMessage(
        apiError("self_approval_not_allowed"),
        DIRECT_SUMMARY_MESSAGES,
      ),
    ).toBe(
      "You can’t approve your own pull request. Choose Comment or ask another reviewer to approve it.",
    );
    expect(
      contextualMessage(apiError("rate_limited"), FINISH_REVIEW_MESSAGES),
    ).toBe("GitHub rate-limited this request. Wait a moment, then try again.");
  });

  it("falls back to the surface's own line when the cause is not an API failure", () => {
    for (const cause of [new Error("boom"), "boom", undefined]) {
      expect(contextualMessage(cause, FINISH_REVIEW_MESSAGES)).toBe(
        "Patchdesk could not finish this review. Check GitHub again or refresh.",
      );
      expect(contextualMessage(cause, DIRECT_SUMMARY_MESSAGES)).toBe(
        "Patchdesk could not submit this review summary. Check GitHub again or refresh.",
      );
      expect(contextualMessage(cause, PENDING_REVIEW_RECOVERY_MESSAGES)).toBe(
        "Patchdesk could not reconcile this pending review. Try again or refresh.",
      );
    }
  });
});

describe("isOutcomeUnknownRetry", () => {
  it("recognises exactly the kinds that leave a write unconfirmed", () => {
    const unknown: ReadonlyArray<ApiFailureKind> = [
      "outcome_unknown",
      "ambiguous_write",
      "timeout",
    ];
    const known: ReadonlyArray<ApiFailureKind> = [
      "rejected",
      "github_rejected",
      "stale_head",
      "pending_review",
      "review_write_in_progress",
      "forbidden",
      "auth",
      "rate_limited",
      "internal",
    ];
    for (const kind of unknown)
      expect(
        isOutcomeUnknownRetry(
          new PatchdeskApiError(kind, 500, false, "test", "unused"),
        ),
      ).toBe(true);
    for (const kind of known)
      expect(
        isOutcomeUnknownRetry(
          new PatchdeskApiError(kind, 500, false, "test", "unused"),
        ),
      ).toBe(false);
  });

  it("does not recognise a plain error", () => {
    expect(isOutcomeUnknownRetry(new Error("boom"))).toBe(false);
    expect(isOutcomeUnknownRetry(undefined)).toBe(false);
  });
});
