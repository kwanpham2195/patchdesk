import { afterEach, describe, expect, it } from "vitest";

import { ProfileStore } from "../../src/adapters/storage/profile-store";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { ReviewWriteOperationStore } from "../../src/adapters/storage/review-write-operation-store";
import { ViewedFilesStore } from "../../src/adapters/storage/viewed-files-store";
import { ok } from "../../src/domain/result";
import { ReviewWorkbenchController } from "../../src/services/review-workbench-controller";
import { ReviewWorkbenchProjectionService } from "../../src/services/review-workbench-projection";
import {
  cleanupLocalApplyRoots,
  git,
  localApplyHarness,
  now,
  profileId,
  value,
  type LocalApplyHarness,
} from "./local-apply-fixture";

afterEach(cleanupLocalApplyRoots);

/** The controller behind `POST /v1/reviews/load`, over the harness's stores and open path. */
function workbenchController(
  harness: LocalApplyHarness,
): ReviewWorkbenchController {
  const projection = new ReviewWorkbenchProjectionService(
    new ProfileStore(harness.paths),
    new ReviewSessionStore(harness.paths),
    harness.reviews,
    harness.insights,
    harness.paths,
    new ReviewWriteOperationStore(harness.paths),
    new ViewedFilesStore(harness.paths, { write: () => undefined }),
    harness.operations,
  );
  return new ReviewWorkbenchController(
    // SAFETY: loading a stored local Review never prepares a pull request session.
    {} as never,
    projection,
    // SAFETY: these are every member `load` reaches for a local Review; the pull request members stay unused.
    {
      reviews: harness.reviews,
      journals: { load: async () => ok(undefined) },
      coordinator: harness.coordinator,
      localCheckout: harness.opening,
    } as never,
    () => now,
  );
}

describe("Reopening a stored working-tree Review", () => {
  it("loads it as the maintainer's open while the checkout stays on its branch", async () => {
    const harness = await localApplyHarness();
    const workbench = await harness.open();

    const loaded = await workbenchController(harness).load({
      profileId,
      reviewId: workbench.review.id,
      recordOpen: true,
    });

    expect(value(loaded).session.id).toBe(workbench.session.id);
  });

  it("refuses the maintainer's open after a branch switch and stamps no visit", async () => {
    const harness = await localApplyHarness();
    const workbench = await harness.open();
    const before = value(
      await harness.reviews.load(profileId, workbench.review.id),
    );
    git(harness.repositoryPath, "checkout", "-q", "-b", "other");

    const refused = await workbenchController(harness).load({
      profileId,
      reviewId: workbench.review.id,
      recordOpen: true,
    });

    expect(refused).toEqual({
      _tag: "err",
      error: { reason: "branch_mismatch", currentBranch: "other" },
    });
    expect(
      value(await harness.reviews.load(profileId, workbench.review.id)),
    ).toEqual(before);
  });
});
