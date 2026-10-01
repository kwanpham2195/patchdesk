import { describe, expect, it } from "vitest";

import type { PendingReviewService } from "../../src/services/pending-review-service";
import {
  anchor,
  expected,
  profileId,
  reviewId,
  reviewNodeId,
} from "./review-invariant-fixtures";
import {
  pendingOwner,
  pendingReviewFlow,
  refusedWrite,
  type ViewerReadAfterWrite,
} from "./write-invariant-harness";

/** Refused pending-review writes (issue #755): which refusals are final and which wait for the recorded review's read. */
const submit = (service: PendingReviewService) =>
  service.submit({
    profileId,
    reviewId,
    expected,
    event: "REQUEST_CHANGES",
    summaryBody: "summary",
  });
const discard = (service: PendingReviewService) =>
  service.discard({ profileId, reviewId, expected, confirmation: true });

describe("PendingReviewService refused writes (issue #755)", () => {
  it("settles a refused start and add-thread with no read after the write and keeps the stored state", async () => {
    const start = await pendingReviewFlow(
      refusedWrite,
      { _tag: "None" },
      (service) =>
        service.start({ profileId, reviewId, expected, anchor, body: "note" }),
    )();
    expect(start.result).toMatchObject({
      _tag: "err",
      error: { reason: "github_refused", cause: "unprocessable" },
    });
    expect(start.intentTag()).toBe("None");
    expect(
      start.trace
        .slice(start.trace.indexOf("write:startPendingReviewWithThread"))
        .filter((entry) => entry.startsWith("read:")),
    ).toEqual([]);

    const add = await pendingReviewFlow(
      refusedWrite,
      pendingOwner(),
      (service) =>
        service.addThread({
          profileId,
          reviewId,
          expected,
          anchor,
          body: "note",
          pendingReviewNodeId: reviewNodeId,
        }),
    )();
    expect(add.result).toMatchObject({
      _tag: "err",
      error: { reason: "github_refused", cause: "unprocessable" },
    });
    expect(add.intentTag()).toBe("Pending");
  });

  it("refuses a submit while the recorded pending review is still Pending and keeps that review", async () => {
    const run = await pendingReviewFlow(refusedWrite, pendingOwner(), submit)();
    expect(run.result).toMatchObject({
      _tag: "err",
      error: { reason: "github_refused", cause: "unprocessable" },
    });
    expect(run.intentTag()).toBe("Pending");
    expect(run.writeLock()).toBeUndefined();
  });

  it("refuses a discard while the recorded pending review is still Pending and keeps that review", async () => {
    const run = await pendingReviewFlow(
      refusedWrite,
      pendingOwner(),
      discard,
    )();
    expect(run.result).toMatchObject({
      _tag: "err",
      error: { reason: "github_refused", cause: "unprocessable" },
    });
    expect(run.intentTag()).toBe("Pending");
  });

  const unproven: ReadonlyArray<ViewerReadAfterWrite> = [
    "none",
    "different_review",
    "failed",
  ];
  for (const afterWrite of unproven) {
    for (const [name, command] of [
      ["submit", submit],
      ["discard", discard],
    ] as const) {
      it(`keeps a refused ${name} outcome unknown when the read finds ${afterWrite}`, async () => {
        const run = await pendingReviewFlow(
          refusedWrite,
          pendingOwner(),
          command,
          afterWrite,
        )();
        expect(run.result).toMatchObject({
          _tag: "err",
          error: "outcome_unknown",
        });
        expect(run.intentTag()).toBe("OutcomeUnknown");
      });
    }
  }
});
