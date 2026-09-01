import { describe, expect, it } from "vitest";

import { FakeGitHubAdapter } from "../../src/adapters/github/fake-github-adapter";
import type {
  MaintainerInboxCache,
  MaintainerInboxCacheStore,
} from "../../src/adapters/storage/maintainer-inbox-cache-store";
import type { StorageFailure } from "../../src/adapters/storage/json-file";
import type { ReviewSessionStore } from "../../src/adapters/storage/review-session-store";
import { parseGitSha, parseIsoTimestamp } from "../../src/domain/ids";
import { parsePullRequestInput } from "../../src/domain/pull-request";
import { err, ok, type Result } from "../../src/domain/result";
import type { MaintainerPullRequestSearchPage } from "../../src/domain/github-context";
import type {
  InboxCheckStatusFilter,
  InboxReviewStateFilter,
} from "../../src/domain/maintainer-inbox";
import { parseWorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import {
  MaintainerInboxService,
  type InboxClock,
  type InboxRepositoryRef,
} from "../../src/services/maintainer-inbox-service";
import type { GitHubReader } from "../../src/adapters/github/github-adapter";

function requireFixture<T, E>(result: Result<T, E>): T {
  if (result._tag === "err") throw new Error("invalid test fixture");
  return result.value;
}

const parsedRepository = requireFixture(
  parsePullRequestInput("centraldigital/patchdesk#1"),
);
const repository: InboxRepositoryRef = parsedRepository;
const profile = requireFixture(
  parseWorkspaceProfileConfig({
    id: "cfw",
    label: "Fixture",
    githubHost: parsedRepository.host,
    ghAccount: "fixture",
    ownerFilters: [],
    workspaceRoots: ["/tmp"],
    rulePaths: [],
    repos: [
      {
        host: parsedRepository.host,
        owner: parsedRepository.owner,
        repo: parsedRepository.repo,
      },
    ],
  }),
);
const timestamp = requireFixture(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
const headSha = requireFixture(parseGitSha("a".repeat(40)));
const baseSha = requireFixture(parseGitSha("b".repeat(40)));

type SearchInput = Parameters<GitHubReader["searchMaintainerPullRequests"]>[0];
type SearchResult = Awaited<
  ReturnType<GitHubReader["searchMaintainerPullRequests"]>
>;

class RecordingGitHubAdapter extends FakeGitHubAdapter {
  constructor(
    private readonly search: (input: SearchInput) => Promise<SearchResult>,
  ) {
    super({ authenticatedAccount: { host: "github.com", account: "fixture" } });
  }

  override searchMaintainerPullRequests(
    input: SearchInput,
  ): Promise<SearchResult> {
    return this.search(input);
  }
}

function serviceWithSearch(
  search: (input: SearchInput) => Promise<SearchResult>,
  cache: Pick<MaintainerInboxCacheStore, "read" | "save"> = {
    read: async () =>
      err<StorageFailure>({
        _tag: "StorageFailure",
        operation: "read",
        reason: "not_found",
      }),
    save: async () => ok(undefined),
  },
): MaintainerInboxService {
  return new MaintainerInboxService(
    new RecordingGitHubAdapter(search),
    { listSessions: async () => ok([]) } satisfies Pick<
      ReviewSessionStore,
      "listSessions"
    >,
    cache,
    { now: () => timestamp } satisfies InboxClock,
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
): MaintainerPullRequestSearchPage["entries"][number] {
  const ref = requireFixture(
    parsePullRequestInput(`centraldigital/patchdesk#${number}`),
  );
  return {
    cursor,
    pullRequest: {
      summary: {
        ref,
        title: `Fixture ${number}`,
        author: "other",
        headBranch: "feature/filter",
        baseBranch: "main",
        headSha,
        baseSha,
        isOpen: true,
        isDraft: false,
        reviewState: "none",
        mergeability: "mergeable",
        labels: [],
        updatedAt: timestamp,
      },
      checks: { overall: "passing", checks: [] },
    },
  };
}

describe("MaintainerInboxService filtered cache writes", () => {
  const filteredCases = [
    { reviewState: "approved" },
    { checkStatus: "failure" },
  ] satisfies ReadonlyArray<{
    readonly reviewState?: InboxReviewStateFilter;
    readonly checkStatus?: InboxCheckStatusFilter;
  }>;

  it.each(filteredCases)(
    "does not cache a read with a %s filter",
    async (filter) => {
      const saved: Array<MaintainerInboxCache> = [];
      const cache: Pick<MaintainerInboxCacheStore, "read" | "save"> = {
        read: async (): Promise<ReturnType<typeof err<StorageFailure>>> =>
          err({
            _tag: "StorageFailure",
            operation: "read",
            reason: "not_found",
          }),
        save: async (_profileId, _repository, cached) => {
          saved.push(cached);
          return ok(undefined);
        },
      };
      const service = serviceWithSearch(
        async () =>
          ok({
            entries: [pullRequestEntry(7, "fixture-7")],
            hasNextPage: false,
            issueCount: 1,
          }),
        cache,
      );

      await service.list(profile, repository, {
        filter: { state: "open", ...filter },
        pageSize: 25,
      });

      expect(saved).toEqual([]);
    },
  );
});
