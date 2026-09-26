import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseFindingId, parseRepoRelativePath } from "../../src/domain/ids";
import {
  applyRequest,
  cleanupLocalApplyRoots,
  git,
  localApplyHarness,
  profileId,
  retainAnalysis,
  suggestionFinding,
  value,
} from "./local-apply-fixture";

afterEach(cleanupLocalApplyRoots);

function present(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

const probe = [
  "export function sum(values: number[]): number {",
  "  let total = 0;",
  "  for (let index = 0; index <= values.length; index += 1) {",
  "    total += values[index] ?? 0;",
  "  }",
  "  return total;",
  "}",
  "",
  "export function greet(name: string): string {",
  "  const greeting = `Hello, ${name}`;",
  "  return greeting;",
  "}",
  "",
].join("\n");
const path = value(parseRepoRelativePath("probe.ts"));

/** A working-tree Review of `probe` with a drafted Finding on line 3 and a note on line 10. */
async function draftedReview() {
  const harness = await localApplyHarness();
  await writeFile(join(harness.repositoryPath, "probe.ts"), probe);
  const workbench = await harness.open();
  const runId = await retainAnalysis(harness.insights, workbench, [
    suggestionFinding(
      "finding-bound",
      "probe.ts",
      { start: 3, end: 3 },
      "  for (let index = 0; index < values.length; index += 1) {",
    ),
  ]);
  const key = {
    profileId,
    reviewId: workbench.review.id,
    sessionId: workbench.session.id,
  };
  value(
    await harness.drafts.add({
      ...key,
      runId,
      findingId: value(parseFindingId("finding-bound")),
    }),
  );
  value(
    await harness.drafts.addNote({
      ...key,
      anchor: { path, side: "new", startLine: 10, line: 10 },
      text: "Use a template literal type.",
    }),
  );
  return { harness, workbench, runId };
}

describe("LocalReviewOpening.refresh", () => {
  it("keeps the session and the drafts as they are when the checkout did not change", async () => {
    const { harness, workbench } = await draftedReview();
    const before = value(
      await harness.reviews.load(profileId, workbench.review.id),
    );

    const refreshed = value(
      await harness.opening.refresh(profileId, workbench.review.id),
    );

    expect(refreshed.session.id).toBe(workbench.session.id);
    const after = value(
      await harness.reviews.load(profileId, workbench.review.id),
    );
    expect(after.currentSessionId).toBe(workbench.session.id);
    expect(after.localDrafts).toEqual(before.localDrafts);
  });

  it("moves an edited Review to a new session, makes it Fresh, and carries each draft with whether its lines changed", async () => {
    const { harness, workbench, runId } = await draftedReview();
    await writeFile(
      join(harness.repositoryPath, "probe.ts"),
      probe.replace("index <= values.length", "index < values.length"),
    );
    // An Apply on the session the checkout moved past records the change.
    const refusedApply = await harness.service.apply(
      applyRequest(workbench, runId, ["finding-bound"]),
    );
    const stale = value(
      await harness.reviews.load(profileId, workbench.review.id),
    );

    const refreshed = value(
      await harness.opening.refresh(profileId, workbench.review.id),
    );

    expect(refreshed.session.id).not.toBe(workbench.session.id);
    expect(refreshed.insights.analysis.status).not.toBe("current");
    expect(refreshed.localDrafts).toEqual([
      expect.objectContaining({
        kind: "finding",
        findingId: "finding-bound",
        sessionId: refreshed.session.id,
        startLine: 3,
        line: 3,
        suggests: false,
        state: "changed",
      }),
      expect.objectContaining({
        kind: "note",
        sessionId: refreshed.session.id,
        startLine: 10,
        line: 10,
        state: "unchanged",
      }),
    ]);
    const stored = value(
      await harness.reviews.load(profileId, workbench.review.id),
    );
    expect(refusedApply).toEqual({
      _tag: "err",
      error: { reason: "revision_changed" },
    });
    expect(stale.freshness._tag).toBe("RevisionChanged");
    expect(stored.freshness).toEqual({ _tag: "Fresh" });
    expect(stored.currentSessionId).toBe(refreshed.session.id);
    expect(stored.localDrafts?.[0]?.anchor.selectedLines).toEqual([
      "  for (let index = 0; index < values.length; index += 1) {",
    ]);
  });

  it("removes the superseded worktree on Refresh and checks it out again when the checkout returns to it", async () => {
    const { harness, workbench } = await draftedReview();
    const firstWorktree = harness.paths.worktreeDirectory(
      profileId,
      workbench.session.id,
    );
    await writeFile(join(harness.repositoryPath, "probe.ts"), `${probe}//\n`);
    value(await harness.opening.refresh(profileId, workbench.review.id));
    const prunedWorktree = await present(firstWorktree);
    await writeFile(join(harness.repositoryPath, "probe.ts"), probe);

    const reverted = value(
      await harness.opening.refresh(profileId, workbench.review.id),
    );

    // The retained Analysis names the first session, so its patch stayed and only its worktree went.
    expect(prunedWorktree).toBe(false);
    expect(reverted.session.id).toBe(workbench.session.id);
    expect(await present(join(firstWorktree, "probe.ts"))).toBe(true);
    expect(reverted.localDrafts).toEqual([
      expect.objectContaining({
        kind: "finding",
        sessionId: workbench.session.id,
        state: "unchanged",
      }),
      expect.objectContaining({
        kind: "note",
        sessionId: workbench.session.id,
        state: "unchanged",
      }),
    ]);
  });

  it("refuses a working-tree Refresh after a branch switch and leaves the Review as it was", async () => {
    const { harness, workbench } = await draftedReview();
    const before = value(
      await harness.reviews.load(profileId, workbench.review.id),
    );
    git(harness.repositoryPath, "checkout", "-q", "-b", "other");

    const refused = await harness.opening.refresh(
      profileId,
      workbench.review.id,
    );

    expect(refused).toEqual({
      _tag: "err",
      error: { reason: "branch_mismatch", currentBranch: "other" },
    });
    expect(
      value(await harness.reviews.load(profileId, workbench.review.id)),
    ).toEqual(before);
  });

  it("refuses while another operation holds the Review and moves nothing", async () => {
    const { harness, workbench } = await draftedReview();
    await writeFile(join(harness.repositoryPath, "probe.ts"), `${probe}//\n`);
    const before = value(
      await harness.reviews.load(profileId, workbench.review.id),
    );
    const key = `${profileId}:${workbench.review.id}`;
    expect(harness.coordinator.acquire(key)).toBe(true);

    const refused = await harness.opening.refresh(
      profileId,
      workbench.review.id,
    );
    harness.coordinator.release(key);

    expect(refused).toEqual({ _tag: "err", error: { reason: "in_progress" } });
    expect(
      value(await harness.reviews.load(profileId, workbench.review.id)),
    ).toEqual(before);
  });
});
