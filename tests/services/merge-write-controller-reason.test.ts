import { describe, expect, it } from "vitest";

import { mergeReason } from "../../src/services/merge-write-controller";

/**
 * Direct unit test of the MergeFailure tag -> wire-reason mapping, kept in
 * its own file so it never needs the module-mocking `merge-write-controller.test.ts`
 * already uses for its full-flow tests.
 */
describe("mergeReason", () => {
  it("maps a forbidden merge write to its own 'merge_forbidden' reason, not the generic 'merge_failed'", () => {
    expect(mergeReason("GitHubMergeForbidden")).toBe("merge_forbidden");
    expect(mergeReason("GitHubMergeForbidden")).not.toBe("merge_failed");
  });

  it("still maps every other known MergeFailure tag exactly as before (no regression)", () => {
    expect(mergeReason("MergeBlocked")).toBe("merge_blocked");
    expect(mergeReason("MergeAcknowledgementRequired")).toBe(
      "merge_acknowledgement_required",
    );
    expect(mergeReason("StaleHeadBlocksMerge")).toBe("stale_head");
    expect(mergeReason("RevisionChangedBlocksMerge")).toBe("stale_head");
    expect(mergeReason("RevisionUnavailableBlocksMerge")).toBe("not_fresh");
    expect(mergeReason("GitHubMergeRateLimited")).toBe("merge_rate_limited");
    expect(mergeReason("GitHubMergeRejected")).toBe("merge_failed");
  });
});
