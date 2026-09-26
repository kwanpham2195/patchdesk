import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseIsoTimestamp,
  parseRepoRelativePath,
  parseReviewId,
  type IsoTimestamp,
  type ReviewSessionId,
} from "../../src/domain/ids";
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

const path = value(parseRepoRelativePath("probe.ts"));

function present(target: string): Promise<boolean> {
  return access(target).then(
    () => true,
    () => false,
  );
}

function sessionRef(sessionId: string): string {
  return `refs/patchdesk/local/${profileId}/${sessionId}/head`;
}

function localRefs(repositoryPath: string): ReadonlyArray<string> {
  const listed = git(
    repositoryPath,
    "for-each-ref",
    "--format=%(refname)",
    "refs/patchdesk/local/",
  ).trim();
  return listed === "" ? [] : listed.split("\n");
}

function later(milliseconds: number): IsoTimestamp {
  return value(
    parseIsoTimestamp(new Date(Date.parse(now) + milliseconds).toISOString()),
  );
}

/** `probe.ts` with ten lines, the last one set to `last`; line 2 and its context stay the same. */
function probeContent(last: number): string {
  return Array.from({ length: 10 }, (_, index) =>
    index === 9
      ? `const v10 = ${String(last)};\n`
      : `const v${String(index + 1)} = 0;\n`,
  ).join("");
}

/** A maintainer-opened working-tree Review of `probe.ts` with a note on line 2. */
async function notedReview(harness: LocalApplyHarness) {
  const probe = join(harness.repositoryPath, "probe.ts");
  await writeFile(probe, probeContent(0));
  const workbench = await harness.open();
  const reviewId = value(parseReviewId(workbench.review.id));
  value(
    await harness.drafts.addNote({
      profileId,
      reviewId,
      sessionId: workbench.session.id,
      anchor: { path, side: "new", startLine: 2, line: 2 },
      text: "Name b after what it counts.",
    }),
  );
  return { probe, workbench, reviewId };
}

/** Holds the first preparation the opening service runs once armed, and says when it is held. */
function preparationHold() {
  let armed = false;
  let reachedResolve!: () => void;
  let releaseResolve!: () => void;
  const reached = new Promise<void>((resolve) => {
    reachedResolve = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  return {
    arm: () => {
      armed = true;
    },
    reached,
    release: releaseResolve,
    afterPrepare: async () => {
      if (!armed) return;
      armed = false;
      reachedResolve();
      await released;
    },
  };
}

describe("LocalReviewOpening.prepareForAgent", () => {
  it("prepares an edited checkout's session and leaves the Review on its session with its drafts and open time", async () => {
    const harness = await localApplyHarness();
    const { probe, workbench, reviewId } = await notedReview(harness);
    const before = value(await harness.reviews.load(profileId, reviewId));
    await writeFile(probe, probeContent(1));

    const prepared = value(
      await harness.opening.prepareForAgent(profileId, reviewId),
    );

    expect(prepared).toMatchObject({
      reviewId,
      sessionId: workbench.session.id,
      changed: true,
    });
    const preparedSessionId = prepared.preparedSessionId;
    if (preparedSessionId === undefined) throw new Error("nothing prepared");
    expect(preparedSessionId).not.toBe(workbench.session.id);
    const after = value(await harness.reviews.load(profileId, reviewId));
    expect(after.currentSessionId).toBe(workbench.session.id);
    expect(after.lastOpenedAt).toBe(before.lastOpenedAt);
    expect(after.localDrafts).toEqual(before.localDrafts);
    expect(after.preparedSessionId).toBe(preparedSessionId);
    expect(after.freshness).toMatchObject({
      _tag: "RevisionChanged",
      identity: { headSha: prepared.headSha, baseSha: prepared.baseSha },
    });
    expect(
      await present(
        harness.paths.worktreeDirectory(profileId, preparedSessionId),
      ),
    ).toBe(true);
    expect(localRefs(harness.repositoryPath)).toContain(
      sessionRef(preparedSessionId),
    );
  });

  it("lets the maintainer's Refresh move the Review to exactly the prepared session, carrying the drafts", async () => {
    const harness = await localApplyHarness();
    const { probe, reviewId } = await notedReview(harness);
    await writeFile(probe, probeContent(1));
    const prepared = value(
      await harness.opening.prepareForAgent(profileId, reviewId),
    );

    const refreshed = value(await harness.opening.refresh(profileId, reviewId));

    expect(refreshed.session.id).toBe(prepared.preparedSessionId);
    expect(refreshed.revision.freshness).toBe("fresh");
    expect(refreshed.localDrafts).toEqual([
      expect.objectContaining({
        kind: "note",
        sessionId: prepared.preparedSessionId,
        line: 2,
        state: "unchanged",
      }),
    ]);
    const stored = value(await harness.reviews.load(profileId, reviewId));
    expect(stored.preparedSessionId).toBeUndefined();
  });

  it("answers changed: false for a checkout that still holds the Review's session", async () => {
    const harness = await localApplyHarness();
    const { workbench, reviewId } = await notedReview(harness);

    const prepared = value(
      await harness.opening.prepareForAgent(profileId, reviewId),
    );

    expect(prepared).toMatchObject({
      sessionId: workbench.session.id,
      changed: false,
      headSha: workbench.session.key.headSha,
    });
    expect(prepared).not.toHaveProperty("preparedSessionId");
    const stored = value(await harness.reviews.load(profileId, reviewId));
    expect(stored.preparedSessionId).toBeUndefined();
    expect(stored.freshness._tag).toBe("Fresh");
  });

  it("clears the prepared session when the checkout returns to the Review's content", async () => {
    let clock = now;
    const harness = await localApplyHarness(undefined, {
      openingNow: () => clock,
    });
    const { probe, reviewId } = await notedReview(harness);
    await writeFile(probe, probeContent(1));
    value(await harness.opening.prepareForAgent(profileId, reviewId));
    await writeFile(probe, probeContent(0));
    clock = later(10_000);

    const reverted = value(
      await harness.opening.prepareForAgent(profileId, reviewId),
    );

    expect(reverted.changed).toBe(false);
    const stored = value(await harness.reviews.load(profileId, reviewId));
    expect(stored.preparedSessionId).toBeUndefined();
    expect(stored.freshness._tag).toBe("Fresh");
  });

  it("refuses a second agent refresh of the Review within 10 s with the wait left, and accepts one after", async () => {
    let clock = now;
    const harness = await localApplyHarness(undefined, {
      openingNow: () => clock,
    });
    const { reviewId } = await notedReview(harness);
    value(await harness.opening.prepareForAgent(profileId, reviewId));
    clock = later(9_000);

    const early = await harness.opening.prepareForAgent(profileId, reviewId);
    clock = later(10_000);
    const due = await harness.opening.prepareForAgent(profileId, reviewId);

    expect(early).toEqual({
      _tag: "err",
      error: { reason: "rate_limited", retryAfterMs: 1_000 },
    });
    expect(due._tag).toBe("ok");
  });

  it("starts no 10 s window for a refused agent refresh, so the retry after fixing the checkout runs at once", async () => {
    const harness = await localApplyHarness();
    const { probe, reviewId } = await notedReview(harness);
    git(harness.repositoryPath, "checkout", "-q", "-b", "other");
    const refused = await harness.opening.prepareForAgent(profileId, reviewId);
    git(harness.repositoryPath, "checkout", "-q", "main");
    await writeFile(probe, probeContent(1));

    const retried = await harness.opening.prepareForAgent(profileId, reviewId);

    expect(refused).toMatchObject({
      _tag: "err",
      error: { reason: "branch_mismatch" },
    });
    expect(retried).toMatchObject({ _tag: "ok", value: { changed: true } });
  });

  it("lets the agent refresh again at once after the maintainer's Refresh moved the Review", async () => {
    const harness = await localApplyHarness();
    const { probe, reviewId } = await notedReview(harness);
    await writeFile(probe, probeContent(1));
    value(await harness.opening.prepareForAgent(profileId, reviewId));
    value(await harness.opening.refresh(profileId, reviewId));
    await writeFile(probe, probeContent(2));

    const next = await harness.opening.prepareForAgent(profileId, reviewId);

    expect(next).toMatchObject({ _tag: "ok", value: { changed: true } });
  });

  it("lets the maintainer save a note while an agent refresh is between its snapshot and its save", async () => {
    const hold = preparationHold();
    const harness = await localApplyHarness(undefined, {
      afterPrepare: hold.afterPrepare,
    });
    const { probe, workbench, reviewId } = await notedReview(harness);
    await writeFile(probe, probeContent(1));
    hold.arm();
    const refreshing = harness.opening.prepareForAgent(profileId, reviewId);
    await hold.reached;

    const noted = await harness.drafts.addNote({
      profileId,
      reviewId,
      sessionId: workbench.session.id,
      anchor: { path, side: "new", startLine: 5, line: 5 },
      text: "Explain v5.",
    });
    hold.release();
    const prepared = value(await refreshing);

    expect(noted._tag).toBe("ok");
    const stored = value(await harness.reviews.load(profileId, reviewId));
    expect(stored.localDrafts).toHaveLength(2);
    expect(stored.currentSessionId).toBe(workbench.session.id);
    expect(stored.preparedSessionId).toBe(prepared.preparedSessionId);
  });

  it("refuses a second agent refresh of the Review while the first is reading the checkout", async () => {
    const hold = preparationHold();
    const harness = await localApplyHarness(undefined, {
      afterPrepare: hold.afterPrepare,
    });
    const { probe, reviewId } = await notedReview(harness);
    await writeFile(probe, probeContent(1));
    hold.arm();
    const first = harness.opening.prepareForAgent(profileId, reviewId);
    await hold.reached;

    const second = await harness.opening.prepareForAgent(profileId, reviewId);
    hold.release();

    expect(second).toEqual({ _tag: "err", error: { reason: "in_progress" } });
    expect((await first)._tag).toBe("ok");
  });

  it("records nothing when the maintainer's Refresh moved the Review to the same content during the agent refresh", async () => {
    const hold = preparationHold();
    const harness = await localApplyHarness(undefined, {
      afterPrepare: hold.afterPrepare,
    });
    const { probe, reviewId } = await notedReview(harness);
    await writeFile(probe, probeContent(1));
    hold.arm();
    const refreshing = harness.opening.prepareForAgent(profileId, reviewId);
    await hold.reached;

    const moved = value(await harness.opening.refresh(profileId, reviewId));
    hold.release();
    const prepared = value(await refreshing);

    expect(prepared).toMatchObject({
      changed: false,
      sessionId: moved.session.id,
    });
    const stored = value(await harness.reviews.load(profileId, reviewId));
    expect(stored.preparedSessionId).toBeUndefined();
    expect(stored.freshness._tag).toBe("Fresh");
  });

  it("refuses an agent refresh whose snapshot the maintainer's Refresh moved past, recording nothing", async () => {
    const hold = preparationHold();
    const harness = await localApplyHarness(undefined, {
      afterPrepare: hold.afterPrepare,
    });
    const { probe, reviewId } = await notedReview(harness);
    await writeFile(probe, probeContent(1));
    hold.arm();
    const refreshing = harness.opening.prepareForAgent(profileId, reviewId);
    await hold.reached;
    await writeFile(probe, probeContent(2));

    const moved = value(await harness.opening.refresh(profileId, reviewId));
    hold.release();
    const prepared = await refreshing;

    expect(prepared).toEqual({ _tag: "err", error: { reason: "in_progress" } });
    const stored = value(await harness.reviews.load(profileId, reviewId));
    expect(stored.currentSessionId).toBe(moved.session.id);
    expect(stored.preparedSessionId).toBeUndefined();
  });

  it("prunes the first prepared session when a second agent refresh prepares newer content", async () => {
    let clock = now;
    const harness = await localApplyHarness(undefined, {
      openingNow: () => clock,
    });
    const { probe, workbench, reviewId } = await notedReview(harness);
    await writeFile(probe, probeContent(1));
    const first = value(
      await harness.opening.prepareForAgent(profileId, reviewId),
    );
    await writeFile(probe, probeContent(2));
    clock = later(10_000);

    const second = value(
      await harness.opening.prepareForAgent(profileId, reviewId),
    );

    const firstId = first.preparedSessionId;
    const secondId = second.preparedSessionId;
    if (firstId === undefined || secondId === undefined)
      throw new Error("nothing prepared");
    expect(secondId).not.toBe(firstId);
    expect([...localRefs(harness.repositoryPath)].sort()).toEqual(
      [sessionRef(workbench.session.id), sessionRef(secondId)].sort(),
    );
    expect(
      await present(harness.paths.worktreeDirectory(profileId, firstId)),
    ).toBe(false);
  });

  it("keeps the prepared session through the retention sweep and removes the superseded one", async () => {
    const harness = await localApplyHarness();
    const { probe, workbench, reviewId } = await notedReview(harness);
    await writeFile(probe, probeContent(1));
    const moved = value(await harness.opening.refresh(profileId, reviewId));
    await writeFile(probe, probeContent(2));
    const prepared = value(
      await harness.opening.prepareForAgent(profileId, reviewId),
    );
    const preparedSessionId: ReviewSessionId | undefined =
      prepared.preparedSessionId;
    if (preparedSessionId === undefined) throw new Error("nothing prepared");

    value(await harness.retention.sweepProfile(profileId));

    expect([...localRefs(harness.repositoryPath)].sort()).toEqual(
      [sessionRef(moved.session.id), sessionRef(preparedSessionId)].sort(),
    );
    expect(
      await present(
        harness.paths.worktreeDirectory(profileId, preparedSessionId),
      ),
    ).toBe(true);
    expect(
      await present(
        harness.paths.worktreeDirectory(profileId, workbench.session.id),
      ),
    ).toBe(false);
  });

  it("refuses a working-tree Review whose checkout moved to another branch, naming that branch", async () => {
    const harness = await localApplyHarness();
    const { reviewId } = await notedReview(harness);
    git(harness.repositoryPath, "checkout", "-q", "-b", "other");

    const prepared = await harness.opening.prepareForAgent(profileId, reviewId);

    expect(prepared).toEqual({
      _tag: "err",
      error: { reason: "branch_mismatch", currentBranch: "other" },
    });
    const stored = value(await harness.reviews.load(profileId, reviewId));
    expect(stored.preparedSessionId).toBeUndefined();
  });
});
