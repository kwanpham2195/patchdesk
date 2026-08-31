import { describe, expect, it } from "vitest";

import type { MaintainerInboxCache } from "../../src/adapters/storage/maintainer-inbox-cache-store";
import { err, ok } from "../../src/domain/result";
import { MaintainerInboxService } from "../../src/services/maintainer-inbox-service";

// SAFETY: this focused service fixture supplies only the fields read on the
// cached fallback path; plain strings stand in for branded identities.
const repository = {
  host: "github.com",
  owner: "centraldigital",
  repo: "patchdesk",
} as never;

// SAFETY: the cache-fallback path reads only profile identity/account.
const profile = { id: "cfw", ghAccount: "fixture" } as never;

describe("MaintainerInboxService cached secondary action", () => {
  it("serves a cached saved Review without its fresh-only merge-readiness action", async () => {
    const cachedRow = {
      remoteState: "open",
      identity: {
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number: 42,
      },
      title: "Ready review",
      author: "author",
      baseBranch: "main",
      headBranch: "feature/ready-review",
      currentHeadSha: "a".repeat(40),
      isDraft: false,
      updatedAt: "2026-08-01T00:00:00.000Z",
      changeStats: {},
      checks: { overall: "passing", checks: [] },
      reviewState: "approved",
      mergeability: "mergeable",
      labels: [],
      latestReview: {
        reviewId: "cfw__centraldigital__patchdesk__pr-42__review-abcdef123456",
        reviewedHeadSha: "a".repeat(40),
        updatedAt: "2026-08-01T00:00:00.000Z",
        matchesCurrentHead: true,
      },
      categories: ["ready_to_merge"],
      recommendedAction: {
        kind: "open_saved_review",
        label: "Open Review",
        reviewId: "cfw__centraldigital__patchdesk__pr-42__review-abcdef123456",
      },
      secondaryAction: {
        kind: "open_merge_readiness",
        label: "Open merge readiness",
        reviewId: "cfw__centraldigital__patchdesk__pr-42__review-abcdef123456",
      },
      dataFreshness: "fresh",
    };
    const cache: MaintainerInboxCache = {
      schemaVersion: 1,
      // SAFETY: the fixed timestamp is valid fixture data.
      refreshedAt: "2026-08-01T00:00:00.000Z" as never,
      // SAFETY: cachedRow is deliberately unbranded fixture data; the cache
      // boundary validates brands before this service receives it.
      rows: [cachedRow as never],
      repository: { identity: repository, state: "ready", complete: true },
    };
    // SAFETY: this fixture implements only the collaborators used by the
    // failed-authentication cache fallback.
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          err({ _tag: "GitHubAuthenticationFailed" }),
        searchMaintainerPullRequests: async () =>
          ok({ entries: [], hasNextPage: false, issueCount: 0 }),
      } as never,
      { listSessions: async () => ok([]) } as never,
      {
        read: async () => ok(cache),
        save: async () => ok(undefined),
      } as never,
      { now: () => "2026-08-01T04:00:00.000Z" as never },
    );

    const result = await service.list(profile, repository);

    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        dataFreshness: "cached",
        rows: [
          {
            recommendedAction: {
              kind: "open_saved_review",
              label: "Open Review",
            },
          },
        ],
      },
    });
    if (result._tag === "ok")
      expect(result.value.rows[0]?.secondaryAction).toBeUndefined();
    expect(cachedRow.secondaryAction).toEqual({
      kind: "open_merge_readiness",
      label: "Open merge readiness",
      reviewId: "cfw__centraldigital__patchdesk__pr-42__review-abcdef123456",
    });
  });
});
