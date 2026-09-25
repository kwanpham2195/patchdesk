import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { writeAtomicJson } from "../../src/adapters/storage/json-file";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { RecentWriteJournalStore } from "../../src/adapters/storage/recent-write-journal-store";
import {
  parseReviewWriteOperation,
  type ReviewWriteIntent,
  type ReviewWriteOperation,
} from "../../src/domain/review-write-operation";
import { ok } from "../../src/domain/result";
import {
  classifyMetadataIntent,
  ReviewWriteRecoveryService,
} from "../../src/services/review-write-recovery-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import { confirmedWriteJournal } from "./write-invariant-harness";

const createdAt = (() => {
  const value = new Date("2026-01-01T00:00:01.000Z").toISOString();
  return value as never;
})();

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("metadata recovery evidence", () => {
  const metadataOperation = (
    intent: Extract<
      ReviewWriteIntent,
      {
        readonly _tag:
          | "AddLabels"
          | "RemoveLabels"
          | "AddAssignees"
          | "RemoveAssignees"
          | "RequestReviewers"
          | "RemoveReviewers"
          | "SetDraftState"
          | "SetBaseBranch";
      }
    >,
  ): ReviewWriteOperation => {
    const parsed = parseReviewWriteOperation({
      schemaVersion: 1,
      profileId: "acme",
      reviewId: "acme__octo-org__patchdesk__pr-42__review-abcdef123456",
      sessionId:
        "github.com__octo-org__patchdesk__pr-42__sha-11111111__base-22222222__abcdef123456",
      intent,
      state: { _tag: "OutcomeUnknown", resolution: "check_required" },
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    if (parsed._tag === "err") throw new Error("invalid fixture");
    return parsed.value;
  };

  it.each([
    [
      { _tag: "AddLabels", names: ["bug"] },
      { labels: [{ name: "bug", color: "fff" }] },
      { _tag: "LabelChange", added: ["bug"], removed: [] },
    ],
    [
      { _tag: "RemoveLabels", names: ["bug"] },
      { labels: [] },
      { _tag: "LabelChange", added: [], removed: ["bug"] },
    ],
    [
      { _tag: "AddAssignees", logins: ["octocat"] },
      { labels: [], assignees: ["octocat"] },
      { _tag: "AssigneeChange", added: ["octocat"], removed: [] },
    ],
    [
      { _tag: "RemoveAssignees", logins: ["octocat"] },
      { labels: [], assignees: [] },
      { _tag: "AssigneeChange", added: [], removed: ["octocat"] },
    ],
    [
      { _tag: "RequestReviewers", logins: ["hubot"] },
      { labels: [], requestedReviewers: ["hubot"] },
      { _tag: "ReviewerChange", requested: ["hubot"], removed: [] },
    ],
    [
      { _tag: "RemoveReviewers", logins: ["hubot"] },
      { labels: [], requestedReviewers: [] },
      { _tag: "ReviewerChange", requested: [], removed: ["hubot"] },
    ],
    [
      { _tag: "SetDraftState", draft: false },
      { labels: [], isDraft: false },
      { _tag: "DraftStateChange", draft: false },
    ],
    [
      { _tag: "SetDraftState", draft: true },
      { labels: [], isDraft: true },
      { _tag: "DraftStateChange", draft: true },
    ],
    [
      { _tag: "SetBaseBranch", branch: "release/1.2" },
      { labels: [], baseBranch: "release/1.2" },
      { _tag: "BaseBranchChange", branch: "release/1.2" },
    ],
  ] as const)(
    "confirms exact membership for %s",
    (intent, summary, receipt) => {
      expect(
        classifyMetadataIntent(metadataOperation(intent), summary as never),
      ).toEqual(receipt);
    },
  );

  it.each([
    [{ _tag: "AddLabels", names: ["bug"] }, { labels: [] }],
    [
      { _tag: "RemoveLabels", names: ["bug"] },
      { labels: [{ name: "bug", color: "fff" }] },
    ],
    [
      { _tag: "AddAssignees", logins: ["octocat"] },
      { labels: [], assignees: [] },
    ],
    [
      { _tag: "RemoveAssignees", logins: ["octocat"] },
      { labels: [], assignees: ["octocat"] },
    ],
    [
      { _tag: "RequestReviewers", logins: ["hubot"] },
      { labels: [], requestedReviewers: [] },
    ],
    [
      { _tag: "RemoveReviewers", logins: ["hubot"] },
      { labels: [], requestedReviewers: ["hubot"] },
    ],
    [
      { _tag: "SetDraftState", draft: false },
      { labels: [], isDraft: true },
    ],
    [
      { _tag: "SetDraftState", draft: true },
      { labels: [], isDraft: false },
    ],
    [
      { _tag: "SetBaseBranch", branch: "release/1.2" },
      { labels: [], baseBranch: "main" },
    ],
  ] as const)(
    "keeps %s check-required when membership disagrees",
    (intent, summary) => {
      expect(
        classifyMetadataIntent(metadataOperation(intent), summary as never),
      ).toBeUndefined();
    },
  );

  it("recovers metadata through the current session across head movement", async () => {
    const value = metadataOperation({ _tag: "AddLabels", names: ["bug"] });
    const requireFresh = vi.fn();
    const requireCurrentSession = vi.fn(async () =>
      ok({
        profile: {},
        session: {
          id: value.sessionId,
          key: {
            host: "github.com",
            owner: "octo-org",
            repo: "patchdesk",
            source: { kind: "pull_request", prNumber: 42 },
            headSha: "1".repeat(40),
          },
        },
      } as never),
    );
    const getPullRequestComments = vi.fn();
    const recentWrites = confirmedWriteJournal();
    const remove = vi.fn(async () => ok(undefined));
    const service = new ReviewWriteRecoveryService(
      { requireFresh, requireCurrentSession },
      {
        getPullRequest: vi.fn(async () =>
          ok({
            labels: [{ name: "bug", color: "fff" }],
            headSha: "9".repeat(40),
          } as never),
        ),
        getPullRequestComments,
      },
      {
        load: vi.fn(async () => ok(value)),
        markOutcomeUnknown: vi.fn(async () => ok(undefined)),
        confirm: vi.fn(async () => ok(undefined)),
        remove,
      },
      recentWrites,
      new ReviewOperationCoordinator(),
      () => createdAt,
    );
    await expect(
      service.recover({ profileId: value.profileId, reviewId: value.reviewId }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        _tag: "Confirmed",
        receipt: { _tag: "LabelChange", added: ["bug"], removed: [] },
      },
    });
    expect(requireCurrentSession).toHaveBeenCalledOnce();
    expect(requireFresh).not.toHaveBeenCalled();
    expect(getPullRequestComments).not.toHaveBeenCalled();
    expect(recentWrites.appendConfirmed).toHaveBeenCalledExactlyOnceWith(
      value.profileId,
      value.reviewId,
      { _tag: "LabelChange", added: ["bug"], removed: [] },
      createdAt,
    );
    expect(remove).toHaveBeenCalledOnce();
  });

  it("clears a confirmed draft-state operation against the real journal", async () => {
    // The journal already holds the toggle's receipt, exactly as the write
    // path leaves it, so recovery reads it back before appending its own.
    const parsed = parseReviewWriteOperation({
      schemaVersion: 1,
      profileId: "acme",
      reviewId: "acme__octo-org__patchdesk__pr-42__review-abcdef123456",
      sessionId:
        "github.com__octo-org__patchdesk__pr-42__sha-11111111__base-22222222__abcdef123456",
      intent: { _tag: "SetDraftState", draft: true },
      state: {
        _tag: "Confirmed",
        receipt: { _tag: "DraftStateChange", draft: true },
      },
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    if (parsed._tag === "err") throw new Error("invalid fixture");
    const value = parsed.value;
    const root = await mkdtemp(join(tmpdir(), "patchdesk-draft-recovery-"));
    roots.push(root);
    const paths = PatchdeskPaths.forTest(root);
    const seeded = await writeAtomicJson(
      paths.recentWriteJournalFile(value.profileId, value.reviewId),
      {
        schemaVersion: 1,
        entries: [
          {
            _tag: "DraftStateChange",
            draft: true,
            writtenAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    );
    expect(seeded._tag).toBe("ok");
    const remove = vi.fn(async () => ok(undefined));
    const service = new ReviewWriteRecoveryService(
      { requireFresh: vi.fn(), requireCurrentSession: vi.fn() },
      {
        getPullRequest: vi.fn(),
        getPullRequestComments: vi.fn(),
      },
      {
        load: vi.fn(async () => ok(value)),
        markOutcomeUnknown: vi.fn(async () => ok(undefined)),
        confirm: vi.fn(async () => ok(undefined)),
        remove,
      },
      new RecentWriteJournalStore(paths, { write: () => undefined }),
      new ReviewOperationCoordinator(),
      () => createdAt,
    );
    await expect(
      service.recover({ profileId: value.profileId, reviewId: value.reviewId }),
    ).resolves.toEqual({
      _tag: "ok",
      value: {
        _tag: "Confirmed",
        receipt: { _tag: "DraftStateChange", draft: true },
      },
    });
    expect(remove).toHaveBeenCalledOnce();
  });

  it("never confirms removal from omitted optional arrays", () => {
    expect(
      classifyMetadataIntent(
        metadataOperation({ _tag: "RemoveAssignees", logins: ["octocat"] }),
        { labels: [] } as never,
      ),
    ).toBeUndefined();
    expect(
      classifyMetadataIntent(
        metadataOperation({ _tag: "RemoveReviewers", logins: ["hubot"] }),
        { labels: [] } as never,
      ),
    ).toBeUndefined();
  });
});
