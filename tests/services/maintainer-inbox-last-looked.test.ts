import { describe, expect, it } from "vitest";

import { MaintainerInboxService } from "../../src/services/maintainer-inbox-service";
import { err, ok } from "../../src/domain/result";

// SAFETY: MaintainerInboxService reads only host/owner/repo off the
// repository parameter; the plain strings stand in for the branded types.
const repository = {
  host: "github.com",
  owner: "centraldigital",
  repo: "patchdesk",
} as never;

const headSha = "a".repeat(40);
const earlierHeadSha = "c".repeat(40);

describe("MaintainerInboxService last-looked head", () => {
  const session = {
    key: {
      profileId: "cfw",
      host: "github.com",
      owner: "centraldigital",
      repo: "patchdesk",
      prNumber: 42,
      headSha,
    },
    patchPath: "/nowhere/patch.diff",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  const github = {
    resolveAuthenticatedAccount: async () =>
      ok({ host: "github.com", account: "fixture" }),
    searchMaintainerPullRequests: async () =>
      ok({
        entries: [
          {
            cursor: "row-42",
            pullRequest: {
              summary: {
                ref: {
                  host: "github.com",
                  owner: "centraldigital",
                  repo: "patchdesk",
                  number: 42,
                },
                title: "Fixture",
                author: "other",
                headSha,
                baseSha: "b".repeat(40),
                isOpen: true,
                isDraft: false,
                reviewState: "none",
                mergeability: "mergeable",
                labels: [],
                updatedAt: "2026-08-01T00:00:00.000Z",
              },
              checks: { overall: "passing", checks: [] },
            },
          },
        ],
        hasNextPage: false,
        issueCount: 1,
      }),
  };

  async function rowFor(
    review: ReturnType<typeof ok> | ReturnType<typeof err>,
  ) {
    // SAFETY: each collaborator implements only the members the service calls.
    const service = new MaintainerInboxService(
      github as never,
      { listSessions: async () => ok([session]) } as never,
      {
        read: async () => err({ reason: "not_found" }),
        save: async () => ok(undefined),
      } as never,
      { now: () => "2026-08-01T00:00:00.000Z" as never },
      undefined,
      undefined,
      { load: async () => review } as never,
    );
    // SAFETY: only the profile fields the service reads are set.
    const listed = await service.list(
      { id: "cfw", ghAccount: "fixture" } as never,
      repository,
    );
    if (listed._tag === "err") throw new Error("expected an inbox page");
    return listed.value.rows[0];
  }

  it("marks the row when the Review was last left at an earlier head", async () => {
    const row = await rowFor(ok({ lastLooked: { headSha: earlierHeadSha } }));
    expect(row).toMatchObject({
      latestReview: { lastLookedHeadSha: earlierHeadSha },
      headMovedSinceLastLooked: true,
    });
  });

  it("leaves the row unmarked when the Review was never left or cannot be read", async () => {
    for (const review of [ok({}), err({ reason: "invalid_stored_value" })]) {
      const row = await rowFor(review);
      expect(row?.headMovedSinceLastLooked).toBe(false);
      expect(row?.latestReview).not.toHaveProperty("lastLookedHeadSha");
    }
  });
});
