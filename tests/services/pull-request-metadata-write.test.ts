import { describe, expect, it, vi } from "vitest";

import { AssigneeService } from "../../src/services/assignee-service";
import { LabelService } from "../../src/services/label-service";
import { ReviewerService } from "../../src/services/reviewer-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import { ok } from "../../src/domain/result";
import {
  makeGate,
  makeRecentWrites,
  now,
  profileId,
  reviewId,
} from "./pull-request-metadata-fixtures";

/**
 * The guarantees `runGuardedMetadataWrite` owns for every pull request
 * metadata write, asserted against all three real services rather than
 * against the shared function alone — a service that stopped routing through
 * it would still typecheck, and only driving the real `execute` catches that.
 *
 * Each service's own suite keeps everything specific to its write. What is
 * here is only what the three genuinely share, and specifically the two
 * guarantees no per-service suite covered before the consolidation: that a
 * thrown write releases the Review lock, and that validation is refused
 * ahead of the lock rather than behind it.
 */

const permissionEvidence = ok({
  account: "octocat",
  permission: "write" as const,
  pullRequestsWrite: true,
  canManageLabels: true,
});

/** The reads every metadata write makes before its own GitHub call. */
function baseGateway() {
  return {
    resolveAuthenticatedAccount: vi.fn(async () =>
      ok({ host: "github.com", account: "octocat" }),
    ),
    getRepositoryPermission: vi.fn(async () => permissionEvidence),
    // SAFETY: the services only read `nodeId` and `assignees` from this stub.
    getPullRequest: vi.fn(async () =>
      ok({ nodeId: "PR_node", assignees: [] } as never),
    ),
  };
}

const throwingWrite = vi.fn(async () => {
  throw new Error("github write threw");
});

/**
 * One entry per metadata write: how to build the service with a GitHub write
 * that throws, plus a valid and an empty command for that write.
 */
const services = [
  {
    name: "LabelService",
    build: (coordinator: ReviewOperationCoordinator) =>
      new LabelService(
        makeGate(),
        // SAFETY: the mock implements only the Gateway methods the exercised
        // path calls.
        { ...baseGateway(), addLabelsToLabelable: throwingWrite } as never,
        coordinator,
        now,
        makeRecentWrites(),
      ),
    valid: { _tag: "AddLabels", labels: [{ id: "LA_bug", name: "bug" }] },
    empty: { _tag: "AddLabels", labels: [] },
  },
  {
    name: "AssigneeService",
    build: (coordinator: ReviewOperationCoordinator) =>
      new AssigneeService(
        makeGate(),
        { ...baseGateway(), addAssigneesToAssignable: throwingWrite } as never,
        coordinator,
        now,
        makeRecentWrites(),
      ),
    valid: {
      _tag: "AddAssignees",
      assignees: [{ id: "U_1", login: "octocat" }],
    },
    empty: { _tag: "AddAssignees", assignees: [] },
  },
  {
    name: "ReviewerService",
    build: (coordinator: ReviewOperationCoordinator) =>
      new ReviewerService(
        makeGate(),
        { ...baseGateway(), requestReviews: throwingWrite } as never,
        coordinator,
        now,
        makeRecentWrites(),
      ),
    valid: {
      _tag: "RequestReviewers",
      reviewers: [{ id: "U_1", login: "octocat" }],
    },
    empty: { _tag: "RequestReviewers", reviewers: [] },
  },
] as const;

describe.each(services)(
  "$name guarded pull request metadata write",
  ({ build, valid, empty }) => {
    it("releases the Review lock when the GitHub write throws", async () => {
      const coordinator = new ReviewOperationCoordinator();
      // SAFETY: each entry's command literal is a valid variant of that
      // service's own command union.
      const service = build(coordinator);
      await expect(
        service.execute({ profileId, reviewId, command: valid as never }),
      ).rejects.toThrow("github write threw");
      // The throw escaped, but the Review must not be stranded: a second
      // attempt reaches the write again rather than being refused as
      // already in flight.
      await expect(
        service.execute({ profileId, reviewId, command: valid as never }),
      ).rejects.toThrow("github write threw");
    });

    it("refuses an invalid command ahead of the lock, not behind it", async () => {
      const coordinator = new ReviewOperationCoordinator();
      const service = build(coordinator);
      // Somebody else holds the Review. An invalid command must still come
      // back as `invalid_input`: validation runs before the lock is even
      // attempted, so a request that cannot succeed never queues behind one
      // that might.
      expect(coordinator.acquire(`${profileId}:${reviewId}`)).toBe(true);
      await expect(
        service.execute({ profileId, reviewId, command: empty as never }),
      ).resolves.toEqual({ _tag: "err", error: "invalid_input" });
    });
  },
);
