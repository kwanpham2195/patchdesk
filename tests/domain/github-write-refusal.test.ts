import { describe, expect, it } from "vitest";

import {
  REFUSAL_CAUSES,
  WRITE_KINDS,
  refusalFinality,
  type WriteKind,
} from "../../src/domain/github-write-refusal";
import { REVIEW_WRITE_INTENT_TAGS } from "../../src/domain/review-write-operation";

/** The per-write decisions recorded in issue #755, restated one kind at a time. */
const expected = {
  CreateComment: "final",
  Reply: "final",
  EditComment: "final",
  EditPublishedComment: "final",
  DirectSummaryReview: "final",
  PendingReviewStart: "final",
  PendingReviewAddThread: "final",
  SetThreadState: "landed_check",
  DeleteComment: "landed_check",
  DeletePublishedComment: "landed_check",
  DismissPublishedReview: "landed_check",
  PendingReviewSubmit: "landed_check",
  PendingReviewDiscard: "landed_check",
  AddLabels: "landed_check",
  RemoveLabels: "landed_check",
  AddAssignees: "landed_check",
  RemoveAssignees: "landed_check",
  RequestReviewers: "landed_check",
  RemoveReviewers: "landed_check",
  SetDraftState: "landed_check",
  SetBaseBranch: "landed_check",
  Merge: "landed_check",
} as const satisfies Record<WriteKind, "final" | "landed_check">;

describe("refusalFinality", () => {
  it("covers every Review write intent, pending-review operation, direct summary review, and merge", () => {
    expect([...WRITE_KINDS].sort()).toEqual(Object.keys(expected).sort());
    for (const tag of REVIEW_WRITE_INTENT_TAGS)
      expect(WRITE_KINDS).toContain(tag);
  });

  for (const kind of WRITE_KINDS) {
    it(`${kind} answers ${expected[kind]} for a refusal a landed first delivery could repeat`, () => {
      for (const cause of REFUSAL_CAUSES.filter((c) => c !== "unsupported"))
        expect(refusalFinality(kind, cause)).toBe(expected[kind]);
    });

    it(`${kind} is final for an unsupported endpoint`, () => {
      expect(refusalFinality(kind, "unsupported")).toBe("final");
    });
  }
});
