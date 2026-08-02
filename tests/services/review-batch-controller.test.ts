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
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseReviewAttemptId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { parseReviewBatch, type ReviewBatch } from "../../src/domain/review-batch";
import { createReviewSession, type ReviewSession } from "../../src/domain/review-session";
import { ReviewBatchController } from "../../src/services/review-batch-controller";

function must<T>(
  value:
    | { readonly _tag: "ok"; readonly value: T }
    | { readonly _tag: "err" },
): T {
  if (value._tag === "err") throw new Error("Invalid fixture");
  return value.value;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(
  batchOverride: Readonly<Record<string, unknown>> = {},
  options: { readonly prepared?: boolean } = {},
): Promise<{
  readonly store: ReviewSessionStore;
  readonly profileId: ReviewSession["key"]["profileId"];
  readonly session: ReviewSession;
  readonly batch: ReviewBatch;
}> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-batch-controller-"));
  roots.push(root);
  const store = new ReviewSessionStore(PatchdeskPaths.forTest(root));
  const profileId = must(parseWorkspaceProfileId("cfw"));
  const host = must(parseGitHubHost("github.com"));
  const owner = must(parseGitHubOwner("centraldigital"));
  const repo = must(parseGitHubRepoName("patchdesk"));
  const prNumber = must(parsePullRequestNumber(42));
  const headSha = must(
    parseGitSha("abcdef1234567890abcdef1234567890abcdef12"),
  );
  const attemptId = must(parseReviewAttemptId("001"));
  const createdAt = must(parseIsoTimestamp("2026-07-16T00:00:00.000Z"));
  const base = createReviewSession({
    key: { profileId, host, owner, repo, prNumber, headSha },
    pr: { headSha, isDraft: false, isOpen: true },
    patchPath: must(parseAbsolutePath(join(root, "patch.diff"))),
    worktree: {
      path: must(parseAbsolutePath(join(root, "worktree"))),
      headSha,
    },
    createdAt,
  });
  const batch = must(
    parseReviewBatch({
      sessionId: base.id,
      state: { _tag: "Local" },
      summaryBody: "Original summary",
      suggestedEvent: "REQUEST_CHANGES",
      items: options.prepared
        ? []
        : [
            {
              _tag: "InlineComment",
              id: "finding-a",
              provenance: { _tag: "model", attemptId },
              source: "finding",
              findingId: "finding-a",
              anchor: {
                path: "src/a.ts",
                startLine: 8,
                line: 8,
                side: "new",
              },
              body: "Original A",
              include: true,
              postability: "postable",
            },
          ],
      receipts: [],
      createdAt,
      updatedAt: createdAt,
      ...batchOverride,
    }),
  );
  const session: ReviewSession = {
    ...base,
    ...(options.prepared
      ? {}
      : {
          state: { _tag: "ReviewCompleted" as const, attemptId },
          currentAttemptId: attemptId,
        }),
    batch: { state: batch.state },
    batchContent: batch,
    ...(batch.state._tag === "Submitted"
      ? {
          submittedReview: {
            reviewId: batch.state.reviewId,
            event: batch.state.event,
            submittedAt: createdAt,
          },
        }
      : {}),
  };
  expect(await store.save(session)).toEqual({ _tag: "ok", value: undefined });
  return { store, profileId, session, batch };
}

function updateInput(
  value: Awaited<ReturnType<typeof fixture>>,
  command: unknown,
) {
  return {
    profileId: value.profileId,
    sessionId: value.session.id,
    expectedRevision: value.batch.updatedAt,
    command,
  };
}

function controller(store: ReviewSessionStore): ReviewBatchController {
  return new ReviewBatchController(
    store,
    () => must(parseIsoTimestamp("2026-07-16T00:01:00.000Z")),
  );
}

describe("ReviewBatchController", () => {
  it("adds a human comment to an editable prepared snapshot before an AI run", async () => {
    const value = await fixture({}, { prepared: true });

    const updated = await controller(value.store).update({
      profileId: value.profileId,
      sessionId: value.session.id,
      expectedRevision: value.batch.updatedAt,
      command: {
        _tag: "AddInlineComment",
        anchor: { path: "src/prepared.ts", startLine: 4, line: 4, side: "new" },
        fingerprint: {
          path: "src/prepared.ts",
          side: "new",
          startLine: 4,
          line: 4,
          selectedLines: ["Keep the snapshot-owned guard."],
          before: [],
          after: [],
        },
        body: "Keep the snapshot-owned guard.",
      },
    });

    expect(updated).toMatchObject({
      _tag: "ok",
      value: {
        batch: {
          items: [
            {
              _tag: "InlineComment",
              provenance: { _tag: "human" },
              source: "manual",
              fingerprint: {
                path: "src/prepared.ts",
                selectedLines: ["Keep the snapshot-owned guard."],
              },
            },
          ],
        },
      },
    });
  });

  it("persists Finding-derived draft provenance and the exact anchor fingerprint", async () => {
    const value = await fixture({}, { prepared: true });
    const updated = await controller(value.store).update(updateInput(value, {
      _tag: "AddFindingInlineComment",
      findingId: "analysis-finding",
      runId: `insight-analysis-1-aaaaaaaaaaaa-${value.session.id}`,
      anchor: { path: "src/prepared.ts", startLine: 4, line: 4, side: "new" },
      fingerprint: {
        path: "src/prepared.ts",
        side: "new",
        startLine: 4,
        line: 4,
        selectedLines: ["Keep the snapshot-owned guard."],
        before: [],
        after: [],
      },
      body: "Keep the snapshot-owned guard.",
    }));
    expect(updated).toMatchObject({
      _tag: "ok",
      value: {
        batch: {
          items: [{
            _tag: "InlineComment",
            provenance: { _tag: "insight", runId: `insight-analysis-1-aaaaaaaaaaaa-${value.session.id}` },
            source: "finding",
            findingId: "analysis-finding",
            fingerprint: { selectedLines: ["Keep the snapshot-owned guard."] },
          }],
        },
      },
    });
  });

  it("adds general feedback and converts an inline item without losing identity", async () => {
    const prepared = await fixture({}, { prepared: true });
    const added = await controller(prepared.store).update(updateInput(prepared, {
      _tag: "AddGeneralComment",
      body: "Please document the migration boundary.",
    }));
    expect(added).toMatchObject({ _tag: "ok", value: { batch: { items: [{ _tag: "GeneralComment", id: "general-1", source: "manual", body: "Please document the migration boundary." }] } } });

    const existing = await fixture();
    const converted = await controller(existing.store).update(updateInput(existing, {
      _tag: "ConvertInlineToGeneral",
      itemId: "finding-a",
    }));
    expect(converted).toMatchObject({ _tag: "ok", value: { batch: { items: [{ _tag: "GeneralComment", id: "finding-a", provenance: { _tag: "model" }, findingId: "finding-a", body: "Original A" }] } } });
  });

  it("adds a side-aware manual range and returns the canonical durable batch", async () => {
    const value = await fixture();
    const updated = await controller(value.store).update(
      updateInput(value, {
        _tag: "AddInlineComment",
        anchor: {
          path: "src/manual.ts",
          startLine: 4,
          line: 6,
          side: "old",
        },
        body: "Preserve this guard.",
      }),
    );

    expect(updated).toMatchObject({
      _tag: "ok",
      value: {
        revision: "2026-07-16T00:01:00.000Z",
        batch: {
          state: { _tag: "Local" },
          items: [
            {},
            {
              _tag: "InlineComment",
              id: "manual-1",
              source: "manual",
              anchor: {
                path: "src/manual.ts",
                startLine: 4,
                line: 6,
                side: "old",
              },
              body: "Preserve this guard.",
              include: true,
              postability: "postable",
            },
          ],
        },
      },
    });
    const durable = await value.store.load(
      value.profileId,
      value.session.id,
    );
    expect(durable).toMatchObject({ _tag: "ok" });
    if (updated._tag === "ok" && durable._tag === "ok") {
      expect(updated.value.batch).toEqual(durable.value.batchContent);
      expect(updated.value.session).toEqual(durable.value);
    }
  });

  it("edits and removes an existing local item", async () => {
    const value = await fixture();
    const service = controller(value.store);
    const edited = await service.update(
      updateInput(value, {
        _tag: "EditItem",
        itemId: "finding-a",
        body: "Edited A",
      }),
    );
    expect(edited).toMatchObject({
      _tag: "ok",
      value: {
        batch: { items: [{ id: "finding-a", body: "Edited A" }] },
      },
    });
    if (edited._tag === "err") return;

    const removed = await service.update({
      ...updateInput(value, {
        _tag: "RemoveItem",
        itemId: "finding-a",
      }),
      expectedRevision: edited.value.revision,
    });
    expect(removed).toMatchObject({
      _tag: "ok",
      value: { batch: { items: [] } },
    });
  });

  it("queues one reply and one state action for a thread", async () => {
    const value = await fixture();
    const service = controller(value.store);
    const replied = await service.update(
      updateInput(value, {
        _tag: "AddThreadReply",
        threadId: "thread-1",
        body: "Fixed in the latest commit.",
      }),
    );
    expect(replied).toMatchObject({
      _tag: "ok",
      value: {
        batch: {
          items: [
            {},
            {
              _tag: "ThreadReply",
              id: "reply-thread-1",
              threadId: "thread-1",
              include: true,
            },
          ],
        },
      },
    });
    if (replied._tag === "err") return;

    const resolved = await service.update({
      ...updateInput(value, {
        _tag: "SetThreadState",
        threadId: "thread-1",
        action: "resolve",
      }),
      expectedRevision: replied.value.revision,
    });
    expect(resolved).toMatchObject({
      _tag: "ok",
      value: {
        batch: {
          items: [
            {},
            {},
            {
              _tag: "ThreadState",
              id: "thread-state-thread-1",
              threadId: "thread-1",
              action: "resolve",
              include: true,
            },
          ],
        },
      },
    });
  });

  it("rejects empty bodies, invalid ranges, and unknown item IDs", async () => {
    const value = await fixture();
    const service = controller(value.store);

    await expect(
      service.update(
        updateInput(value, {
          _tag: "AddInlineComment",
          anchor: {
            path: "src/a.ts",
            startLine: 8,
            line: 7,
            side: "new",
          },
          body: "Invalid range",
        }),
      ),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "invalid_input" },
    });
    await expect(
      service.update(
        updateInput(value, {
          _tag: "AddThreadReply",
          threadId: "thread-1",
          body: "   ",
        }),
      ),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "invalid_input" },
    });
    await expect(
      service.update(
        updateInput(value, {
          _tag: "EditItem",
          itemId: "missing",
          body: "Edit",
        }),
      ),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "item_not_found" },
    });
  });

  it("rejects duplicate queued reply and thread-state actions", async () => {
    const value = await fixture({
      items: [
        {
          _tag: "ThreadReply",
          id: "reply-thread-1",
          threadId: "thread-1",
          body: "Queued",
          include: true,
        },
        {
          _tag: "ThreadState",
          id: "thread-state-thread-1",
          threadId: "thread-1",
          action: "resolve",
          include: true,
        },
      ],
    });
    const service = controller(value.store);

    await expect(
      service.update(
        updateInput(value, {
          _tag: "AddThreadReply",
          threadId: "thread-1",
          body: "Duplicate",
        }),
      ),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "duplicate_thread_action" },
    });
    await expect(
      service.update(
        updateInput(value, {
          _tag: "SetThreadState",
          threadId: "thread-1",
          action: "reopen",
        }),
      ),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "duplicate_thread_action" },
    });
  });

  it("serializes compare-and-set updates so only one stale revision wins", async () => {
    const value = await fixture();
    const service = controller(value.store);
    const input = updateInput(value, {
      _tag: "EditItem",
      itemId: "finding-a",
      body: "Contender",
    });

    const results = await Promise.all([
      service.update(input),
      service.update({
        ...input,
        command: {
          _tag: "EditItem",
          itemId: "finding-a",
          body: "Other contender",
        },
      }),
    ]);

    expect(results.filter((result) => result._tag === "ok")).toHaveLength(1);
    expect(results.filter((result) => result._tag === "err")).toEqual([
      { _tag: "err", error: { reason: "revision_conflict" } },
    ]);
  });

  it("rejects edits after applying or submission", async () => {
    for (const state of [
      {
        _tag: "Applying",
        operation: {
          _tag: "CreatePendingReview",
          itemIds: ["finding-a"],
        },
      },
      {
        _tag: "PendingReview",
        reviewId: "review-1",
      },
      {
        _tag: "Submitted",
        reviewId: "review-1",
        event: "REQUEST_CHANGES",
      },
    ] as const) {
      const locked = await fixture({
        state,
        receipts:
          state._tag === "PendingReview" || state._tag === "Submitted"
            ? [
                {
                  _tag: "PendingReviewCreated",
                  reviewId: "review-1",
                  itemIds: ["finding-a"] as never,
                },
              ]
            : [],
      });
      await expect(
        controller(locked.store).update(
          updateInput(locked, {
            _tag: "EditItem",
            itemId: "finding-a",
            body: "Too late",
          }),
        ),
      ).resolves.toEqual({
        _tag: "err",
        error: { reason: "batch_not_editable" },
      });
    }
  });

  it("requires acknowledgement before discarding a local batch for rerun", async () => {
    const value = await fixture();
    const service = controller(value.store);

    await expect(
      service.update(
        updateInput(value, {
          _tag: "DiscardForRerun",
          acknowledgement: false,
        }),
      ),
    ).resolves.toEqual({
      _tag: "err",
      error: { reason: "acknowledgement_required" },
    });

    const discarded = await service.update(
      updateInput(value, {
        _tag: "DiscardForRerun",
        acknowledgement: true,
      }),
    );
    expect(discarded).toMatchObject({
      _tag: "ok",
      value: {
        session: {
          state: { _tag: "ReviewCompleted" },
        },
        batch: undefined,
      },
    });
    const durable = await value.store.load(
      value.profileId,
      value.session.id,
    );
    expect(durable).toMatchObject({
      _tag: "ok",
      value: {
        state: { _tag: "ReviewCompleted" },
      },
    });
    if (durable._tag === "ok") {
      expect(durable.value.batch).toBeUndefined();
      expect(durable.value.batchContent).toBeUndefined();
    }
  });
});
