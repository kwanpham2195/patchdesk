import { describe, expect, it } from "vitest";

import type { MaintainerInboxCache } from "../../src/adapters/storage/maintainer-inbox-cache-store";
import { ok } from "../../src/domain/result";
import { MaintainerInboxService } from "../../src/services/maintainer-inbox-service";

const repository = {
  host: "github.com",
  owner: "centraldigital",
  repo: "patchdesk",
} as never;
const profile = { id: "cfw", ghAccount: "fixture" } as never;

type SearchPage = {
  readonly entries: ReadonlyArray<{
    readonly cursor: string;
    readonly pullRequest: {
      readonly summary: object;
      readonly checks: object;
    };
  }>;
  readonly hasNextPage: boolean;
  readonly endCursor?: string;
  readonly issueCount: number;
};
type SearchResult = ReturnType<typeof ok<SearchPage>>;

function serviceWithSearch(
  search: (input: { readonly searchQuery: string }) => Promise<SearchResult>,
): MaintainerInboxService {
  return new MaintainerInboxService(
    {
      resolveAuthenticatedAccount: async () =>
        ok({ host: "github.com", account: "fixture" }),
      searchMaintainerPullRequests: search,
    } as never,
    { listSessions: async () => ok([]) } as never,
    {
      read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
      save: async () => ok(undefined),
    } as never,
    { now: () => "2026-08-01T00:00:00.000Z" as never },
  );
}

describe("MaintainerInboxService review and check filters", () => {
  it("composes review and check filters in canonical qualifier order", async () => {
    const searchQueries: Array<string> = [];
    const service = serviceWithSearch(async (input) => {
      searchQueries.push(input.searchQuery);
      return ok({ entries: [], hasNextPage: false, issueCount: 0 });
    });

    await service.list(profile, repository, {
      filter: {
        state: "open",
        labels: ["bug"],
        awaitingMyReview: true,
        reviewState: "approved",
        checkStatus: "failure",
      },
      pageSize: 25,
    });

    expect(searchQueries).toEqual([
      'repo:centraldigital/patchdesk is:pr is:open user-review-requested:@me review:approved status:failure label:"bug"',
    ]);
  });

  it("rejects a page token changed to a different review or check filter before GitHub", async () => {
    let githubReads = 0;
    const service = serviceWithSearch(async () => {
      githubReads += 1;
      return ok({
        entries: [],
        hasNextPage: true,
        endCursor: "cursor-2",
        issueCount: 0,
      });
    });
    const firstPage = await service.list(profile, repository, {
      filter: {
        state: "open",
        reviewState: "approved",
        checkStatus: "failure",
      },
      pageSize: 25,
    });
    expect(firstPage._tag).toBe("ok");
    if (firstPage._tag !== "ok") return;
    const pageToken = firstPage.value.nextPageToken;
    if (pageToken === undefined) throw new Error("expected a next page token");

    await expect(
      service.list(profile, repository, {
        filter: {
          state: "open",
          reviewState: "changes_requested",
          checkStatus: "failure",
        },
        pageSize: 25,
        pageToken,
      }),
    ).resolves.toEqual({ _tag: "err", error: "invalid_page" });
    await expect(
      service.list(profile, repository, {
        filter: {
          state: "open",
          reviewState: "approved",
          checkStatus: "pending",
        },
        pageSize: 25,
        pageToken,
      }),
    ).resolves.toEqual({ _tag: "err", error: "invalid_page" });
    expect(githubReads).toBe(1);
  });
});

function pullRequestEntry(
  number: number,
  cursor: string,
): SearchPage["entries"][number] {
  return {
    cursor,
    pullRequest: {
      summary: {
        ref: {
          host: "github.com",
          owner: "centraldigital",
          repo: "patchdesk",
          number,
        },
        title: `Fixture ${number}`,
        author: "other",
        headSha: "a".repeat(40),
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
  };
}

describe("MaintainerInboxService filtered cache writes", () => {
  it.each([
    { reviewState: "approved" as const },
    { checkStatus: "failure" as const },
  ])("does not cache a read with a %s filter", async (filter) => {
    const saved: Array<MaintainerInboxCache> = [];
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        searchMaintainerPullRequests: async () =>
          ok({
            entries: [pullRequestEntry(7, "fixture-7")],
            hasNextPage: false,
            issueCount: 1,
          }),
      } as never,
      { listSessions: async () => ok([]) } as never,
      {
        read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
        save: async (cached: MaintainerInboxCache) => {
          saved.push(cached);
          return ok(undefined);
        },
      } as never,
      { now: () => "2026-08-01T00:00:00.000Z" as never },
    );

    await service.list(profile, repository, {
      filter: { state: "open", ...filter },
      pageSize: 25,
    });

    expect(saved).toEqual([]);
  });
});
