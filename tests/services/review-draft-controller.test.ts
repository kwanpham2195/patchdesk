import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import {
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parsePullRequestNumber,
  parseReviewAttemptId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import type { ReviewDraft } from "../../src/domain/review-draft";
import { createReviewSession, type ReviewSession } from "../../src/domain/review-session";
import { ReviewDraftController } from "../../src/services/review-draft-controller";

function must<T>(value: { readonly _tag: "ok"; readonly value: T } | { readonly _tag: "err" }): T {
  if (value._tag === "err") throw new Error("Invalid fixture");
  return value.value;
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-draft-controller-"));
  roots.push(root);
  const store = new ReviewSessionStore(PatchdeskPaths.forTest(root));
  const profileId = must(parseWorkspaceProfileId("cfw"));
  const host = must(parseGitHubHost("github.com"));
  const owner = must(parseGitHubOwner("centraldigital"));
  const repo = must(parseGitHubRepoName("patchdesk"));
  const prNumber = must(parsePullRequestNumber(42));
  const headSha = must(parseGitSha("abcdef1234567890abcdef1234567890abcdef12"));
  const attemptId = must(parseReviewAttemptId("001"));
  const createdAt = "2026-07-16T00:00:00.000Z" as const;
  const base = createReviewSession({
    key: { profileId, host, owner, repo, prNumber, headSha },
    pr: { headSha, isDraft: false, isOpen: true },
    patchPath: must(parseAbsolutePath(join(root, "patch.diff"))),
    worktree: { path: must(parseAbsolutePath(join(root, "worktree"))), headSha },
    createdAt: createdAt as never,
  });
  const draft = {
    sessionId: base.id,
    attemptId,
    state: { _tag: "LocalDraft" },
    summaryBody: "Original summary",
    suggestedEvent: "REQUEST_CHANGES",
    comments: [
      {
        findingId: "finding-a",
        include: true,
        originalSuggestedBody: "Original A",
        body: "Original A",
        path: "src/a.ts",
        line: 8,
        diffSide: "new",
        postability: "postable",
      },
      {
        findingId: "finding-b",
        include: true,
        originalSuggestedBody: "Original B",
        body: "Original B",
        path: "src/b.ts",
        line: 12,
        diffSide: "old",
        postability: "invalid_line",
      },
    ],
    createdAt,
    updatedAt: createdAt,
  } as unknown as ReviewDraft;
  const session = {
    ...base,
    state: { _tag: "ReviewCompleted", attemptId },
    currentAttemptId: attemptId,
    draft: { state: draft.state },
    draftContent: draft,
  } as ReviewSession;
  expect(await store.save(session)).toMatchObject({ _tag: "ok" });
  return { store, profileId, session, draft };
}

function updateInput(value: Awaited<ReturnType<typeof fixture>>) {
  return {
    profileId: value.profileId,
    sessionId: value.session.id,
    expectedRevision: value.draft.updatedAt,
    summaryBody: "Edited summary",
    comments: [
      { findingId: "finding-a", include: false, body: "Edited A" },
      { findingId: "finding-b", include: true, body: "Edited B" },
    ],
  };
}

describe("ReviewDraftController", () => {
  it("persists only editable fields and returns the exact durable draft", async () => {
    const value = await fixture();
    const controller = new ReviewDraftController(
      value.store,
      () => "2026-07-16T00:01:00.000Z" as never,
    );

    const updated = await controller.update(updateInput(value));

    expect(updated).toMatchObject({
      _tag: "ok",
      value: {
        revision: "2026-07-16T00:01:00.000Z",
        draft: {
          summaryBody: "Edited summary",
          comments: [
            {
              findingId: "finding-a",
              include: false,
              body: "Edited A",
              path: "src/a.ts",
              line: 8,
              originalSuggestedBody: "Original A",
              postability: "postable",
            },
            {
              findingId: "finding-b",
              include: true,
              body: "Edited B",
              path: "src/b.ts",
              line: 12,
              originalSuggestedBody: "Original B",
              postability: "invalid_line",
            },
          ],
        },
      },
    });
    const durable = await value.store.load(value.profileId, value.session.id);
    expect(durable).toMatchObject({ _tag: "ok" });
    if (updated._tag === "ok" && durable._tag === "ok") {
      expect(updated.value.draft).toEqual(durable.value.draftContent);
      expect(updated.value.session).toEqual(durable.value);
    }
  });

  it("rejects a stale revision without overwriting the newer draft", async () => {
    const value = await fixture();
    const controller = new ReviewDraftController(
      value.store,
      () => "2026-07-16T00:01:00.000Z" as never,
    );
    const first = await controller.update(updateInput(value));
    expect(first).toMatchObject({ _tag: "ok" });

    await expect(
      controller.update({ ...updateInput(value), summaryBody: "Stale overwrite" }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "revision_conflict" } });
    await expect(value.store.load(value.profileId, value.session.id)).resolves.toMatchObject({
      _tag: "ok",
      value: { draftContent: { summaryBody: "Edited summary" } },
    });
  });

  it("serializes concurrent compare-and-set updates so only one stale revision wins", async () => {
    const value = await fixture();
    const controller = new ReviewDraftController(
      value.store,
      () => "2026-07-16T00:01:00.000Z" as never,
    );
    const input = updateInput(value);

    const results = await Promise.all([
      controller.update({ ...input, summaryBody: "First contender" }),
      controller.update({ ...input, summaryBody: "Second contender" }),
    ]);

    expect(results.filter((result) => result._tag === "ok")).toHaveLength(1);
    expect(results.filter((result) => result._tag === "err")).toEqual([
      { _tag: "err", error: { reason: "revision_conflict" } },
    ]);
  });

  it("rejects missing, duplicate, or unknown comment identities", async () => {
    const value = await fixture();
    const controller = new ReviewDraftController(
      value.store,
      () => "2026-07-16T00:01:00.000Z" as never,
    );
    const input = updateInput(value);

    await expect(
      controller.update({ ...input, comments: input.comments.slice(0, 1) }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "draft_shape_mismatch" } });
    await expect(
      controller.update({ ...input, comments: [input.comments[0], input.comments[0]] }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "draft_shape_mismatch" } });
    await expect(
      controller.update({
        ...input,
        comments: [input.comments[0], { ...input.comments[1], findingId: "unknown" }],
      }),
    ).resolves.toEqual({ _tag: "err", error: { reason: "draft_shape_mismatch" } });
  });

  it("does not edit a pending GitHub review", async () => {
    const value = await fixture();
    const pending = {
      ...value.draft,
      state: {
        _tag: "PendingGitHubReview",
        pendingReviewId: "9001",
        commentCount: 1,
      },
    } as ReviewDraft;
    expect(
      await value.store.save({
        ...value.session,
        draft: { state: pending.state },
        draftContent: pending,
      }),
    ).toMatchObject({ _tag: "ok" });
    const controller = new ReviewDraftController(
      value.store,
      () => "2026-07-16T00:01:00.000Z" as never,
    );

    await expect(controller.update(updateInput(value))).resolves.toEqual({
      _tag: "err",
      error: { reason: "draft_not_editable" },
    });
  });
});
