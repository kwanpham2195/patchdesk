import { describe, expect, it } from "vitest";

import type { GitHubReader } from "../../src/adapters/github/github-adapter";
import { MaintainerInboxService } from "../../src/services/maintainer-inbox-service";
import { ok } from "../../src/domain/result";

// SAFETY: MaintainerInboxService reads only host/owner/repo from this fixture.
const repository = {
  host: "github.com",
  owner: "octo-org",
  repo: "patchdesk",
} as never;

const profile = { id: "acme", ghAccount: "fixture" } as never;

function serviceWithSearch(
  searchMaintainerPullRequests: GitHubReader["searchMaintainerPullRequests"],
): MaintainerInboxService {
  return new MaintainerInboxService(
    {
      resolveAuthenticatedAccount: async () =>
        ok({ host: "github.com", account: "fixture" }),
      searchMaintainerPullRequests,
    } as never,
    { listSessions: async () => ok([]) } as never,
    {
      read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
      save: async () => ok(undefined),
    } as never,
    { now: () => "2026-08-01T00:00:00.000Z" as never },
  );
}

describe("MaintainerInboxService page token validation", () => {
  it("advances an empty non-final repository page with its GraphQL continuation", async () => {
    const cursors: Array<string | undefined> = [];
    const service = serviceWithSearch(async ({ cursor }) => {
      cursors.push(cursor);
      return ok(
        cursors.length === 1
          ? {
              entries: [],
              hasNextPage: true,
              endCursor: "cursor-after-empty-page",
              issueCount: 0,
            }
          : { entries: [], hasNextPage: false, issueCount: 0 },
      );
    });

    const firstPage = await service.list(profile, repository, {
      filter: { state: "open" },
      pageSize: 25,
    });
    if (firstPage._tag !== "ok" || firstPage.value.nextPageToken === undefined)
      throw new Error("expected an opaque continuation token");

    const secondPage = await service.list(profile, repository, {
      filter: { state: "open" },
      pageSize: 25,
      pageToken: firstPage.value.nextPageToken,
    });
    expect(secondPage._tag).toBe("ok");
    expect(cursors).toEqual([undefined, "cursor-after-empty-page"]);
  });

  it("rejects a malformed token before repository search", async () => {
    let searches = 0;
    const service = serviceWithSearch(async () => {
      searches += 1;
      throw new Error("GitHub must not receive a malformed inbox token");
    });

    await expect(
      service.list(profile, repository, {
        filter: { state: "open" },
        pageSize: 25,
        pageToken: "not-a-page-token",
      }),
    ).resolves.toEqual({ _tag: "err", error: "invalid_page" });
    expect(searches).toBe(0);
  });

  it("rejects a service-issued token when the requested page size changes", async () => {
    let searches = 0;
    const service = serviceWithSearch(async () => {
      searches += 1;
      return ok({
        entries: [],
        hasNextPage: true,
        endCursor: "next-page",
        issueCount: 0,
      });
    });
    const firstPage = await service.list(profile, repository, {
      filter: { state: "open" },
      pageSize: 10,
    });
    if (firstPage._tag !== "ok" || firstPage.value.nextPageToken === undefined)
      throw new Error("expected an opaque continuation token");

    await expect(
      service.list(profile, repository, {
        filter: { state: "open" },
        pageSize: 25,
        pageToken: firstPage.value.nextPageToken,
      }),
    ).resolves.toEqual({ _tag: "err", error: "invalid_page" });
    expect(searches).toBe(1);
  });

  it("rejects a token from another repository before a second repository search", async () => {
    const searchedRepositories: Array<string> = [];
    const service = serviceWithSearch(async ({ repo }) => {
      searchedRepositories.push(repo.repo);
      return ok({
        entries: [],
        hasNextPage: true,
        endCursor: "next-page",
        issueCount: 0,
      });
    });
    const otherRepository = {
      host: "github.com",
      owner: "octo-org",
      repo: "some-other-repo",
    } as never;
    const firstPage = await service.list(profile, otherRepository, {
      filter: { state: "open" },
      pageSize: 25,
    });
    if (firstPage._tag !== "ok" || firstPage.value.nextPageToken === undefined)
      throw new Error("expected an opaque continuation token");

    await expect(
      service.list(profile, repository, {
        filter: { state: "open" },
        pageSize: 25,
        pageToken: firstPage.value.nextPageToken,
      }),
    ).resolves.toEqual({ _tag: "err", error: "invalid_page" });
    expect(searchedRepositories).toEqual(["some-other-repo"]);
  });
});

describe("MaintainerInboxService page size", () => {
  it("bounds the returned page to the requested page size", async () => {
    function summaryAt(number: number, updatedAt: string) {
      return {
        cursor: `patchdesk-${number}`,
        pullRequest: {
          summary: {
            ref: {
              host: "github.com",
              owner: "octo-org",
              repo: "patchdesk",
              number,
            },
            title: `PR ${number}`,
            author: "other",
            headSha: "a".repeat(40),
            baseSha: "b".repeat(40),
            isOpen: true,
            isDraft: false,
            reviewState: "none",
            mergeability: "mergeable",
            labels: [],
            updatedAt,
          },
          checks: { overall: "passing", checks: [] },
        },
      };
    }
    const service = serviceWithSearch(async () => {
      // SAFETY: this test reader fixture uses plain identifiers in adapter results.
      return ok({
        entries: Array.from({ length: 12 }, (_, index) =>
          summaryAt(
            index + 1,
            `2026-08-${String(12 - index).padStart(2, "0")}T00:00:00.000Z`,
          ),
        ),
        hasNextPage: false,
        issueCount: 12,
      }) as never;
    });

    const result = await service.list(profile, repository, {
      filter: { state: "open" },
      pageSize: 10,
    });

    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    // 12 fixture rows from the repository, truncated to the requested page
    // size of 10 rather than the reader's own count.
    expect(result.value.rows).toHaveLength(10);
    expect(result.value.nextPageToken).toBeDefined();
    expect(result.value.pageSize).toBe(10);
  });
});
