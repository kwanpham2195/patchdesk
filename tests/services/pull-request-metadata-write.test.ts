import { describe, expect, it, vi } from "vitest";

import { AssigneeService } from "../../src/services/assignee-service";
import { LabelService } from "../../src/services/label-service";
import { ReviewerService } from "../../src/services/reviewer-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import { ok } from "../../src/domain/result";
import {
  makeGate,
  makeRecentWrites,
  makeReviewWriteOperations,
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
 * rejected post-boundary writer retains durable outcome-unknown state and is
 * not replayed, and that validation is refused ahead of admission.
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
        makeReviewWriteOperations(),
      ),
    valid: { _tag: "AddLabels", labels: [{ id: "LA_bug", name: "bug" }] },
    empty: { _tag: "AddLabels", labels: [] },
  },
  {
    name: "AssigneeService",
    build: (coordinator: ReviewOperationCoordinator) =>
      new AssigneeService(
        makeGate(),
        // SAFETY: the gateway supplies every method reached by this assignee-write scenario.
        { ...baseGateway(), addAssigneesToAssignable: throwingWrite } as never,
        coordinator,
        now,
        makeRecentWrites(),
        makeReviewWriteOperations(),
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
        // SAFETY: the gateway supplies every method reached by this reviewer-write scenario.
        { ...baseGateway(), requestReviews: throwingWrite } as never,
        coordinator,
        now,
        makeRecentWrites(),
        makeReviewWriteOperations(),
      ),
    valid: {
      _tag: "RequestReviewers",
      reviewers: [{ id: "U_1", login: "octocat" }],
    },
    empty: { _tag: "RequestReviewers", reviewers: [] },
  },
  // SAFETY: every table row constructs and invokes the command variant owned by its paired service.
] as const;

describe.each(services)(
  "$name guarded pull request metadata write",
  ({ build, valid, empty }) => {
    it("retains the durable lock when the GitHub writer rejects", async () => {
      throwingWrite.mockClear();
      const coordinator = new ReviewOperationCoordinator();
      // SAFETY: each entry's command literal is a valid variant of that
      // service's own command union.
      const service = build(coordinator);
      await expect(
        // SAFETY: each valid command comes from the same table row as its owning service.
        service.execute({ profileId, reviewId, command: valid as never }),
      ).resolves.toEqual({ _tag: "err", error: "outcome_unknown" });
      // SAFETY: each valid command comes from the same table row as its owning service.
      await expect(
        service.execute({ profileId, reviewId, command: valid as never }),
      ).resolves.toEqual({ _tag: "err", error: "outcome_unknown" });
      expect(throwingWrite).toHaveBeenCalledOnce();
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
        // SAFETY: each empty command preserves the discriminant owned by its paired service.
        service.execute({ profileId, reviewId, command: empty as never }),
      ).resolves.toEqual({ _tag: "err", error: "invalid_input" });
    });
  },
);
