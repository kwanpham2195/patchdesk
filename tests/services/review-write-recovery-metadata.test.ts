import { describe, expect, it, vi } from "vitest";

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

const createdAt = (() => {
  const value = new Date("2026-01-01T00:00:01.000Z").toISOString();
  return value as never;
})();

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
          | "RemoveReviewers";
      }
    >,
  ): ReviewWriteOperation => {
    const parsed = parseReviewWriteOperation({
      schemaVersion: 1,
      profileId: "cfw",
      reviewId: "cfw__centraldigital__patchdesk__pr-42__review-abcdef123456",
      sessionId:
        "github.com__centraldigital__patchdesk__pr-42__sha-11111111__base-22222222__abcdef123456",
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
            owner: "centraldigital",
            repo: "patchdesk",
            prNumber: 42,
            headSha: "1".repeat(40),
          },
        },
      } as never),
    );
    const getPullRequestComments = vi.fn();
    const append = vi.fn(async () => ok(undefined));
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
      { append },
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
    expect(append).toHaveBeenCalledExactlyOnceWith(
      value.profileId,
      value.reviewId,
      { _tag: "LabelChange", added: ["bug"], removed: [] },
      createdAt,
    );
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
