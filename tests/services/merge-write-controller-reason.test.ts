import { describe, expect, it } from "vitest";

import type { MergeReadiness } from "../../src/domain/merge-readiness";
import { mergeReason } from "../../src/services/merge-write-controller";

const readiness: MergeReadiness = {
  _tag: "Blocked",
  blockers: ["conflicting"],
  warnings: [],
};
// SAFETY: a 40-character hex literal already satisfies the branded GitSha's runtime shape.
const currentHeadSha = "a".repeat(40) as never;

/**
 * Direct unit test of the MergeFailure tag -> wire-reason mapping, kept in
 * its own file so it never needs the module-mocking `merge-write-controller.test.ts`
 * already uses for its full-flow tests.
 */
describe("mergeReason", () => {
  it("maps a forbidden merge write to its own 'merge_forbidden' reason, not the generic 'merge_failed'", () => {
    expect(mergeReason({ _tag: "GitHubMergeForbidden" })).toBe(
      "merge_forbidden",
    );
    expect(mergeReason({ _tag: "GitHubMergeForbidden" })).not.toBe(
      "merge_failed",
    );
  });

  it("still maps every other known MergeFailure tag exactly as before (no regression)", () => {
    expect(mergeReason({ _tag: "MergeBlocked", readiness })).toBe(
      "merge_blocked",
    );
    expect(
      mergeReason({ _tag: "MergeAcknowledgementRequired", readiness }),
    ).toBe("merge_acknowledgement_required");
    expect(mergeReason({ _tag: "StaleHeadBlocksMerge", currentHeadSha })).toBe(
      "stale_head",
    );
    expect(mergeReason({ _tag: "RevisionChangedBlocksMerge" })).toBe(
      "stale_head",
    );
    expect(mergeReason({ _tag: "RevisionUnavailableBlocksMerge" })).toBe(
      "not_fresh",
    );
    expect(mergeReason({ _tag: "GitHubMergeRateLimited" })).toBe(
      "merge_rate_limited",
    );
    expect(mergeReason({ _tag: "GitHubMergeRejected" })).toBe("merge_failed");
  });

  it("names the cause of a merge the repository or GitHub refused", () => {
    expect(mergeReason({ _tag: "MergeMethodNotAllowed" })).toBe(
      "merge_method_not_allowed",
    );
    const reasons = {
      conflict: "merge_head_changed",
      not_allowed: "merge_not_mergeable",
      unprocessable: "merge_not_mergeable",
      not_found: "not_found",
      unsupported: "merge_unsupported",
    } as const;
    for (const [cause, reason] of Object.entries(reasons))
      expect(
        mergeReason({
          _tag: "GitHubMergeRefused",
          // SAFETY: the keys of `reasons` are exactly the RefusalCause values.
          cause: cause as keyof typeof reasons,
        }),
      ).toBe(reason);
  });
});
