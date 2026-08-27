import { describe, expect, it } from "vitest";

import {
  MaintainerInboxService,
  type InboxRepositoryRef,
} from "../../src/services/maintainer-inbox-service";
import { err, ok, type Result } from "../../src/domain/result";
import type { MaintainerInboxCache } from "../../src/adapters/storage/maintainer-inbox-cache-store";
import type { StorageFailure } from "../../src/adapters/storage/json-file";
const REFUSE_AFTER_MS = 4 * 60 * 60 * 1000; // pins the four-hour refuse rule

// SAFETY: MaintainerInboxService reads only host/owner/repo off the
// repository parameter; the plain strings stand in for the branded GitHub
// identity types these fixtures never need to parse.
const repository = {
  host: "github.com",
  owner: "centraldigital",
  repo: "patchdesk",
} as never;

describe("MaintainerInboxService", () => {
  it("uses saved Review identity as the action authority", async () => {
    // SAFETY: test fixture narrows a partial mock (only the members
    // MaintainerInboxService actually calls) to its stricter collaborator
    // and profile types.
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        searchMaintainerPullRequests: async () =>
          ok({
            entries: [
              {
                cursor: "fixture-42",
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
              },
            ],
            hasNextPage: false,
            issueCount: 1,
          }),
      } as never,
      { listSessions: async () => ok([]) } as never,
      {
        read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
        save: async () => ok(undefined),
      } as never,
      { now: () => "2026-08-01T00:00:00.000Z" as never },
    );
    // SAFETY: test fixture narrows a partial profile mock to
    // WorkspaceProfileConfig; only the fields the service reads are set.
    await expect(
      service.list({ id: "cfw", ghAccount: "fixture" } as never, repository),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { rows: [{ recommendedAction: { kind: "run_review" } }] },
    });
  });

  it("reads the merged state and returns only the terminal action", async () => {
    const stateFilters: Array<string | undefined> = [];
    const searchQueries: Array<string> = [];
    // SAFETY: these narrow fixtures implement exactly the service seams under test.
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        searchMaintainerPullRequests: async (input: {
          readonly state?: string;
          readonly searchQuery: string;
        }) => {
          stateFilters.push(input.state);
          searchQueries.push(input.searchQuery);
          return ok({
            entries: [
              {
                cursor: "merged-42",
                pullRequest: {
                  summary: {
                    ref: {
                      host: "github.com",
                      owner: "centraldigital",
                      repo: "patchdesk",
                      number: 42,
                    },
                    title: "Merged fixture",
                    author: "other",
                    headBranch: "feature/merged",
                    baseBranch: "main",
                    headSha: "a".repeat(40),
                    baseSha: "b".repeat(40),
                    isOpen: false,
                    isDraft: false,
                    reviewState: "none",
                    mergeability: "unknown",
                    labels: [],
                    updatedAt: "2026-08-01T00:00:00.000Z",
                  },
                  checks: { overall: "passing", checks: [] },
                },
              },
            ],
            hasNextPage: false,
            issueCount: 1,
          });
        },
        // SAFETY: this fixture implements only the GitHub reader members list() calls.
      } as never,
      // SAFETY: this fixture implements only the session list seam list() calls.
      { listSessions: async () => ok([]) } as never,
      {
        read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
        save: async () => ok(undefined),
        // SAFETY: this fixture implements only the cache read/write seam list() calls.
      } as never,
      // SAFETY: the fixed ISO literal is valid and supplies only this test clock.
      { now: () => "2026-08-01T00:00:00.000Z" as never },
    );

    // SAFETY: this minimal profile supplies exactly the fields list() reads.
    const result = await service.list(
      { id: "cfw", ghAccount: "fixture" } as never,
      repository,
      { filter: { state: "merged" }, pageSize: 25 },
    );

    expect(stateFilters).toEqual(["merged"]);
    expect(searchQueries).toEqual([
      "repo:centraldigital/patchdesk is:pr is:merged",
    ]);
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        state: "merged",
        rows: [
          {
            remoteState: "merged",
            categories: [],
            recommendedAction: { kind: "open_merged_review" },
          },
        ],
      },
    });
  });
});

describe("MaintainerInboxService search query", () => {
  it("requests the open-state search query when no state is given", async () => {
    const searchQueries: Array<string> = [];
    // SAFETY: this fixture implements only the GitHub reader members list() calls.
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        searchMaintainerPullRequests: async (input: {
          readonly searchQuery: string;
        }) => {
          searchQueries.push(input.searchQuery);
          return ok({ entries: [], hasNextPage: false, issueCount: 0 });
        },
      } as never,
      { listSessions: async () => ok([]) } as never,
      {
        read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
        save: async () => ok(undefined),
      } as never,
      { now: () => "2026-08-01T00:00:00.000Z" as never },
    );

    // SAFETY: this minimal profile supplies exactly the fields list() reads.
    await service.list(
      { id: "cfw", ghAccount: "fixture" } as never,
      repository,
    );

    expect(searchQueries).toEqual([
      "repo:centraldigital/patchdesk is:pr is:open",
    ]);
  });

  it("composes selected labels into the search query as label qualifiers", async () => {
    const searchQueries: Array<string> = [];
    // SAFETY: this fixture implements only the GitHub reader members list() calls.
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        searchMaintainerPullRequests: async (input: {
          readonly searchQuery: string;
        }) => {
          searchQueries.push(input.searchQuery);
          return ok({ entries: [], hasNextPage: false, issueCount: 0 });
        },
      } as never,
      { listSessions: async () => ok([]) } as never,
      {
        read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
        save: async () => ok(undefined),
      } as never,
      { now: () => "2026-08-01T00:00:00.000Z" as never },
    );

    // SAFETY: this minimal profile supplies exactly the fields list() reads.
    await service.list(
      { id: "cfw", ghAccount: "fixture" } as never,
      repository,
      { filter: { state: "open", labels: ["bug", "p0"] }, pageSize: 25 },
    );

    expect(searchQueries).toEqual([
      'repo:centraldigital/patchdesk is:pr is:open label:"bug" label:"p0"',
    ]);
  });

  it("composes the Awaiting review from you preset into the search query", async () => {
    const searchQueries: Array<string> = [];
    // SAFETY: this fixture implements only the GitHub reader members list() calls.
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        searchMaintainerPullRequests: async (input: {
          readonly searchQuery: string;
        }) => {
          searchQueries.push(input.searchQuery);
          return ok({ entries: [], hasNextPage: false, issueCount: 0 });
        },
      } as never,
      { listSessions: async () => ok([]) } as never,
      {
        read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
        save: async () => ok(undefined),
      } as never,
      { now: () => "2026-08-01T00:00:00.000Z" as never },
    );

    // A preset, not a queue: it composes beside the state and the label
    // qualifiers rather than replacing them. `@me` reaches GitHub verbatim —
    // GitHub resolves it to the authenticated viewer, so Patchdesk never
    // looks the login up.
    // SAFETY: this minimal profile supplies exactly the fields list() reads.
    await service.list(
      { id: "cfw", ghAccount: "fixture" } as never,
      repository,
      {
        filter: { state: "open", labels: ["bug"], awaitingMyReview: true },
        pageSize: 25,
      },
    );

    expect(searchQueries).toEqual([
      'repo:centraldigital/patchdesk is:pr is:open user-review-requested:@me label:"bug"',
    ]);
  });

  it("omits the Awaiting review from you qualifier when the preset is off", async () => {
    const searchQueries: Array<string> = [];
    // SAFETY: this fixture implements only the GitHub reader members list() calls.
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        searchMaintainerPullRequests: async (input: {
          readonly searchQuery: string;
        }) => {
          searchQueries.push(input.searchQuery);
          return ok({ entries: [], hasNextPage: false, issueCount: 0 });
        },
      } as never,
      { listSessions: async () => ok([]) } as never,
      {
        read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
        save: async () => ok(undefined),
      } as never,
      { now: () => "2026-08-01T00:00:00.000Z" as never },
    );

    // SAFETY: this minimal profile supplies exactly the fields list() reads.
    await service.list(
      { id: "cfw", ghAccount: "fixture" } as never,
      repository,
      { filter: { state: "open", awaitingMyReview: false }, pageSize: 25 },
    );

    expect(searchQueries).toEqual([
      "repo:centraldigital/patchdesk is:pr is:open",
    ]);
  });

  it("rejects a page token minted under a different Awaiting review from you preset", async () => {
    // SAFETY: this fixture implements only the GitHub reader members list() calls.
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        searchMaintainerPullRequests: async () =>
          ok({
            entries: [],
            hasNextPage: true,
            endCursor: "cursor-2",
            issueCount: 0,
          }),
      } as never,
      { listSessions: async () => ok([]) } as never,
      {
        read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
        save: async () => ok(undefined),
      } as never,
      { now: () => "2026-08-01T00:00:00.000Z" as never },
    );

    // SAFETY: this minimal profile supplies exactly the fields list() reads.
    const profile = { id: "cfw", ghAccount: "fixture" } as never;
    const firstPage = await service.list(profile, repository, {
      filter: { state: "open", awaitingMyReview: true },
      pageSize: 25,
    });
    expect(firstPage._tag).toBe("ok");
    if (firstPage._tag !== "ok") return;
    const pageToken = firstPage.value.nextPageToken;
    if (pageToken === undefined) throw new Error("expected a next page token");

    // Turning the preset off is a different search query, so its cursor is
    // rejected the same way a label or repository change is.
    await expect(
      service.list(profile, repository, {
        filter: { state: "open" },
        pageSize: 25,
        pageToken,
      }),
    ).resolves.toMatchObject({ _tag: "err", error: "invalid_page" });
  });

  it("rejects a page token minted under a different label filter", async () => {
    // SAFETY: this fixture implements only the GitHub reader members list() calls.
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        searchMaintainerPullRequests: async () =>
          ok({
            entries: [],
            hasNextPage: true,
            endCursor: "cursor-2",
            issueCount: 0,
          }),
      } as never,
      { listSessions: async () => ok([]) } as never,
      {
        read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
        save: async () => ok(undefined),
      } as never,
      { now: () => "2026-08-01T00:00:00.000Z" as never },
    );

    // SAFETY: this minimal profile supplies exactly the fields list() reads.
    const profile = { id: "cfw", ghAccount: "fixture" } as never;
    const firstPage = await service.list(profile, repository, {
      filter: { state: "open", labels: ["bug"] },
      pageSize: 25,
    });
    expect(firstPage._tag).toBe("ok");
    if (firstPage._tag !== "ok") return;
    const pageToken = firstPage.value.nextPageToken;
    if (pageToken === undefined) throw new Error("expected a next page token");

    // The cursor was minted for `labels: ["bug"]`; requesting the next page
    // under a different label filter must not silently continue the old
    // search — it must be rejected the same way a repository mismatch is.
    const mismatchedPage = await service.list(profile, repository, {
      filter: { state: "open", labels: ["enhancement"] },
      pageSize: 25,
      pageToken,
    });
    expect(mismatchedPage).toMatchObject({
      _tag: "err",
      error: "invalid_page",
    });
  });
});

// The defect this whole plan targets: a maintainer inbox header reading
// "10 merged" because only ten rows are loaded, when the repository
// actually has 237 matches. `searchMaintainerPullRequests`'s `issueCount`
// is GitHub's true repository-wide count; the service must report that,
// not the loaded page's row count.
describe("MaintainerInboxService match count", () => {
  it("reports GitHub's issueCount, not the loaded page's row count, when they differ", async () => {
    function summaryAt(number: number) {
      return {
        cursor: `patchdesk-${number}`,
        pullRequest: {
          summary: {
            ref: {
              host: "github.com",
              owner: "centraldigital",
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
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
          checks: { overall: "passing", checks: [] },
        },
      };
    }
    // SAFETY: this fixture implements only the GitHub reader members list() calls.
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        searchMaintainerPullRequests: async () =>
          ok({
            // The repository-wide search matches 237 pull requests, but
            // only a page of 10 rows is ever loaded.
            entries: Array.from({ length: 10 }, (_, index) =>
              summaryAt(index + 1),
            ),
            hasNextPage: true,
            endCursor: "cursor-11",
            issueCount: 237,
          }),
      } as never,
      { listSessions: async () => ok([]) } as never,
      {
        read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
        save: async () => ok(undefined),
      } as never,
      { now: () => "2026-08-01T00:00:00.000Z" as never },
    );

    // SAFETY: this minimal profile supplies exactly the fields list() reads.
    const result = await service.list(
      { id: "cfw", ghAccount: "fixture" } as never,
      repository,
      { filter: { state: "merged" }, pageSize: 10 },
    );

    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(result.value.rows).toHaveLength(10);
    expect(result.value.matchCount).toBe(237);
  });
});

describe("MaintainerInboxService rate-limited reads", () => {
  it("maps a GitHubRateLimited read failure to the github_rate_limited state and carries resumeAt", async () => {
    // SAFETY: test fixture narrows a partial mock (only the members
    // MaintainerInboxService actually calls) to its stricter collaborator
    // and profile types.
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        searchMaintainerPullRequests: async () =>
          err({
            _tag: "GitHubRateLimited",
            operation: "list_maintainer_prs",
            resumeAt: "2026-08-01T05:00:00.000Z",
          }),
      } as never,
      { listSessions: async () => ok([]) } as never,
      {
        read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
        save: async () => ok(undefined),
      } as never,
      { now: () => "2026-08-01T00:00:00.000Z" as never },
    );
    // SAFETY: test fixture narrows a partial profile mock to
    // WorkspaceProfileConfig; only the fields the service reads are set.
    await expect(
      service.list({ id: "cfw", ghAccount: "fixture" } as never, repository),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        repositories: [
          {
            state: "github_rate_limited",
            resumeAt: "2026-08-01T05:00:00.000Z",
          },
        ],
      },
    });
  });

  it("maps a GitHubRateLimited read failure with no cached resumeAt to github_rate_limited without a resumeAt field", async () => {
    // SAFETY: test fixture narrows a partial mock (only the members
    // MaintainerInboxService actually calls) to its stricter collaborator
    // and profile types.
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        searchMaintainerPullRequests: async () =>
          err({
            _tag: "GitHubRateLimited",
            operation: "list_maintainer_prs",
          }),
      } as never,
      { listSessions: async () => ok([]) } as never,
      {
        read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
        save: async () => ok(undefined),
      } as never,
      { now: () => "2026-08-01T00:00:00.000Z" as never },
    );
    // SAFETY: test fixture narrows a partial profile mock to
    // WorkspaceProfileConfig; only the fields the service reads are set.
    const result = await service.list(
      { id: "cfw", ghAccount: "fixture" } as never,
      repository,
    );
    expect(result).toMatchObject({
      _tag: "ok",
      value: { repositories: [{ state: "github_rate_limited" }] },
    });
    if (result._tag === "ok") {
      expect(result.value.repositories[0]?.resumeAt).toBeUndefined();
    }
  });
});

describe("MaintainerInboxService forbidden reads (plan 009)", () => {
  it("maps a GitHubForbidden read failure to the github_forbidden state and carries forbiddenReason", async () => {
    // SAFETY: test fixture narrows a partial mock (only the members
    // MaintainerInboxService actually calls) to its stricter collaborator
    // and profile types.
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        searchMaintainerPullRequests: async () =>
          err({
            _tag: "GitHubForbidden",
            operation: "list_maintainer_prs",
            reason: "ip_allow_list",
          }),
      } as never,
      { listSessions: async () => ok([]) } as never,
      {
        read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
        save: async () => ok(undefined),
      } as never,
      { now: () => "2026-08-01T00:00:00.000Z" as never },
    );
    // SAFETY: test fixture narrows a partial profile mock to
    // WorkspaceProfileConfig; only the fields the service reads are set.
    // SAFETY: this fixture repository matches the forbidden-owner profile
    // this test exercises; plain strings stand in for branded GitHub types.
    const forbiddenRepository = {
      host: "github.com",
      owner: "OmisePayments",
      repo: "dynamic-onboarding-service",
    } as never;
    // SAFETY: test fixture narrows a partial profile mock to
    // WorkspaceProfileConfig; only the fields the service reads are set.
    await expect(
      service.list(
        { id: "cfw", ghAccount: "fixture" } as never,
        forbiddenRepository,
      ),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: {
        repositories: [
          { state: "github_forbidden", forbiddenReason: "ip_allow_list" },
        ],
      },
    });
  });
});

describe("MaintainerInboxService cache writes", () => {
  const now = "2026-08-01T00:00:00.000Z";
  // SAFETY: test fixture narrows a partial profile mock to
  // WorkspaceProfileConfig; only the fields the service reads are set.
  const profile = { id: "cfw", ghAccount: "fixture" } as never;

  function pullRequestEntry(number: number, cursor: string) {
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

  /** A service whose GitHub read always succeeds with `entries`, recording
   * every `cache.save` call into `saved` so the assertion lands on the cache
   * double itself rather than on a later read. */
  function serviceRecordingSaves(
    entries: ReadonlyArray<ReturnType<typeof pullRequestEntry>>,
    saved: Array<MaintainerInboxCache>,
  ): MaintainerInboxService {
    // SAFETY: these narrow fixtures implement exactly the service seams
    // under test.
    return new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        searchMaintainerPullRequests: async () =>
          ok({ entries, hasNextPage: false, issueCount: entries.length }),
      } as never,
      { listSessions: async () => ok([]) } as never,
      {
        read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
        save: async (
          _profileId: string,
          _repository: InboxRepositoryRef,
          cached: MaintainerInboxCache,
        ) => {
          saved.push(cached);
          return ok(undefined);
        },
      } as never,
      { now: () => now as never },
    );
  }

  it("caches a fresh, complete, first-page read with no label filter", async () => {
    const saved: Array<MaintainerInboxCache> = [];
    const service = serviceRecordingSaves(
      [pullRequestEntry(42, "fixture-42")],
      saved,
    );

    await service.list(profile, repository, {
      filter: { state: "open" },
      pageSize: 25,
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]?.rows.map((row) => row.identity.number)).toEqual([42]);
  });

  it("does not cache a fresh, complete, first-page read that applied a label filter", async () => {
    const saved: Array<MaintainerInboxCache> = [];
    const service = serviceRecordingSaves(
      [pullRequestEntry(7, "fixture-7")],
      saved,
    );

    // Identical to the read above in every respect the save condition used
    // to test — open state, first page, complete, fresh. Only the label
    // filter differs, and the cache is keyed by profile and repository
    // alone, so saving this would present one `label:"bug"` row as the
    // repository's whole inbox.
    await service.list(profile, repository, {
      filter: { state: "open", labels: ["bug"] },
      pageSize: 25,
    });

    expect(saved).toEqual([]);
  });

  it("falls back to the earlier unfiltered cache entry after a label-filtered read, never to the filtered rows", async () => {
    const store: Array<MaintainerInboxCache> = [];
    // SAFETY: these narrow fixtures implement exactly the service seams
    // under test.
    const collaborators = (
      authenticated: boolean,
    ): ConstructorParameters<typeof MaintainerInboxService> =>
      [
        {
          resolveAuthenticatedAccount: async () =>
            authenticated
              ? ok({ host: "github.com", account: "fixture" })
              : err({ _tag: "GitHubAuthenticationFailed" }),
          searchMaintainerPullRequests: async (input: {
            readonly searchQuery: string;
          }) =>
            ok({
              entries: input.searchQuery.includes("label:")
                ? [pullRequestEntry(7, "fixture-7")]
                : [pullRequestEntry(42, "fixture-42")],
              hasNextPage: false,
              issueCount: 1,
            }),
        },
        { listSessions: async () => ok([]) },
        {
          read: async () =>
            store.at(-1) === undefined
              ? { _tag: "err", error: { reason: "not_found" } }
              : ok(store.at(-1)),
          save: async (
            _profileId: string,
            _repository: InboxRepositoryRef,
            cached: MaintainerInboxCache,
          ) => {
            store.push(cached);
            return ok(undefined);
          },
        },
        { now: () => now },
      ] as never;

    const online = new MaintainerInboxService(...collaborators(true));
    await online.list(profile, repository, {
      filter: { state: "open" },
      pageSize: 25,
    });
    await online.list(profile, repository, {
      filter: { state: "open", labels: ["bug"] },
      pageSize: 25,
    });

    // GitHub is now unreachable, so `list` serves whatever the cache holds.
    // The label-filtered read must not have overwritten the unfiltered one.
    const offline = new MaintainerInboxService(...collaborators(false));
    const served = await offline.list(profile, repository, {
      filter: { state: "open" },
      pageSize: 25,
    });

    expect(served._tag).toBe("ok");
    if (served._tag !== "ok") return;
    expect(served.value.rows.map((row) => row.identity.number)).toEqual([42]);
  });

  it("does not cache a read that applied the Awaiting review from you preset", async () => {
    const saved: Array<MaintainerInboxCache> = [];
    const service = serviceRecordingSaves(
      [pullRequestEntry(7, "fixture-7")],
      saved,
    );

    // Same defect class as the label filter: the cache is keyed by profile
    // and repository alone, so a preset-filtered result saved here would come
    // back as the repository's whole inbox.
    await service.list(profile, repository, {
      filter: { state: "open", awaitingMyReview: true },
      pageSize: 25,
    });

    expect(saved).toEqual([]);
  });

  it("serves the unavailable page when the only completed read applied a label filter", async () => {
    const store: Array<MaintainerInboxCache> = [];
    // SAFETY: these narrow fixtures implement exactly the service seams
    // under test.
    const collaborators = (
      authenticated: boolean,
    ): ConstructorParameters<typeof MaintainerInboxService> =>
      [
        {
          resolveAuthenticatedAccount: async () =>
            authenticated
              ? ok({ host: "github.com", account: "fixture" })
              : err({ _tag: "GitHubAuthenticationFailed" }),
          searchMaintainerPullRequests: async () =>
            ok({
              entries: [pullRequestEntry(7, "fixture-7")],
              hasNextPage: false,
              issueCount: 1,
            }),
        },
        { listSessions: async () => ok([]) },
        {
          read: async () =>
            store.at(-1) === undefined
              ? { _tag: "err", error: { reason: "not_found" } }
              : ok(store.at(-1)),
          save: async (
            _profileId: string,
            _repository: InboxRepositoryRef,
            cached: MaintainerInboxCache,
          ) => {
            store.push(cached);
            return ok(undefined);
          },
        },
        { now: () => now },
      ] as never;

    await new MaintainerInboxService(...collaborators(true)).list(
      profile,
      repository,
      { filter: { state: "open", labels: ["bug"] }, pageSize: 25 },
    );
    expect(store).toEqual([]);

    const served = await new MaintainerInboxService(
      ...collaborators(false),
    ).list(profile, repository, { filter: { state: "open" }, pageSize: 25 });

    expect(served).toMatchObject({
      _tag: "ok",
      value: { rows: [], snapshot: { state: "unavailable" } },
    });
  });
});

describe("MaintainerInboxService.cachedOrUnavailable", () => {
  const now = "2026-08-01T04:00:00.000Z";
  // SAFETY: test fixture narrows a partial profile mock to
  // WorkspaceProfileConfig; only the fields the service reads are set.
  const profile = { id: "cfw", ghAccount: "fixture" } as never;

  function serviceWithCache(cache: {
    readonly read: () => Promise<Result<MaintainerInboxCache, StorageFailure>>;
    readonly save: () => Promise<Result<void, StorageFailure>>;
  }): MaintainerInboxService {
    // SAFETY: test fixture narrows partial mocks (only the members
    // MaintainerInboxService actually calls) to its stricter collaborator
    // types.
    return new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () => ({
          _tag: "err",
          error: { _tag: "GitHubAuthenticationFailed" },
        }),
        searchMaintainerPullRequests: async () =>
          ok({ entries: [], hasNextPage: false, issueCount: 0 }),
      } as never,
      { listSessions: async () => ok([]) } as never,
      cache as never,
      { now: () => now as never },
    );
  }

  it("marks a cache just under the refuse threshold as failed_cached", async () => {
    const refreshedAt = new Date(
      Date.parse(now) - (REFUSE_AFTER_MS - 1),
    ).toISOString();
    const service = serviceWithCache({
      read: async () =>
        ok({
          schemaVersion: 1,
          refreshedAt,
          rows: [],
          repository: { identity: repository, state: "ready", complete: true },
        }),
      save: async () => ok(undefined),
    });
    await expect(service.list(profile, repository)).resolves.toMatchObject({
      _tag: "ok",
      value: { snapshot: { state: "failed_cached" } },
    });
  });

  it("marks a cache at the refuse threshold as stale_cached", async () => {
    const refreshedAt = new Date(
      Date.parse(now) - REFUSE_AFTER_MS,
    ).toISOString();
    const service = serviceWithCache({
      read: async () =>
        ok({
          schemaVersion: 1,
          refreshedAt,
          rows: [],
          repository: { identity: repository, state: "ready", complete: true },
        }),
      save: async () => ok(undefined),
    });
    await expect(service.list(profile, repository)).resolves.toMatchObject({
      _tag: "ok",
      value: { snapshot: { state: "stale_cached" } },
    });
  });

  it("still reports unavailable when there is no cache at all", async () => {
    const service = serviceWithCache({
      read: async () =>
        err({
          _tag: "StorageFailure",
          operation: "read",
          reason: "not_found",
        }),
      save: async () => ok(undefined),
    });
    await expect(service.list(profile, repository)).resolves.toMatchObject({
      _tag: "ok",
      value: { snapshot: { state: "unavailable" } },
    });
  });
});

describe("MaintainerInboxService page token validation", () => {
  it("advances an empty non-final repository page with its GraphQL continuation", async () => {
    const service = new MaintainerInboxService(
      // SAFETY: this GitHub fixture implements only the reader members used by list().
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        searchMaintainerPullRequests: async () =>
          ok({
            entries: [],
            hasNextPage: true,
            endCursor: "cursor-after-empty-page",
            issueCount: 0,
          }),
      } as never,
      // SAFETY: list() requires only the session-list seam from this fixture.
      { listSessions: async () => ok([]) } as never,
      // SAFETY: this cache fixture implements only the read/write seam used by list().
      {
        read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
        save: async () => ok(undefined),
      } as never,
      // SAFETY: this test clock returns a valid fixed ISO timestamp.
      { now: () => "2026-08-01T00:00:00.000Z" as never },
    );

    // SAFETY: the minimal profile contains every field read by list().
    const result = await service.list(
      { id: "cfw", ghAccount: "fixture" } as never,
      repository,
    );

    expect(result._tag).toBe("ok");
    if (result._tag === "err") return;
    expect(result.value.nextPageToken).toBeDefined();
    const token = JSON.parse(
      Buffer.from(result.value.nextPageToken ?? "", "base64url").toString(
        "utf8",
      ),
    );
    expect(token.repository).toEqual({
      host: "github.com",
      owner: "centraldigital",
      repo: "patchdesk",
    });
    expect(token.cursor).toBe("cursor-after-empty-page");
  });

  it("rejects malformed tokens before reading GitHub", async () => {
    const searchMaintainerPullRequests = async (): Promise<never> => {
      throw new Error("GitHub must not receive malformed inbox tokens");
    };
    // SAFETY: test fixture narrows partial collaborators to the exact
    // dependency surface exercised before malformed-token rejection.
    const service = new MaintainerInboxService(
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

    await expect(
      service.list(
        // SAFETY: the malformed-token path only reads the profile id and
        // account supplied by this focused fixture.
        { id: "cfw", ghAccount: "fixture" } as never,
        repository,
        {
          filter: { state: "open" },
          pageSize: 25,
          pageToken: "not-a-page-token",
        },
      ),
    ).resolves.toEqual({ _tag: "err", error: "invalid_page" });
  });

  it("rejects a page token whose recorded size does not match the requested size", async () => {
    const searchMaintainerPullRequests = async (): Promise<never> => {
      throw new Error("GitHub must not receive a size-mismatched inbox token");
    };
    // SAFETY: test fixture narrows partial collaborators to the exact
    // dependency surface exercised before malformed-token rejection.
    const service = new MaintainerInboxService(
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

    // SAFETY: the malformed-token path only reads the profile id and account
    // supplied by this focused fixture.
    const profile = { id: "cfw", ghAccount: "fixture" } as never;

    // Mint a token by hand that records a size of 10, then request it back
    // at size 25 — the mismatch must be rejected before any GitHub read.
    const tokenForSizeTen = Buffer.from(
      JSON.stringify({
        state: "open",
        page: 2,
        size: 10,
        repository: {
          host: "github.com",
          owner: "centraldigital",
          repo: "patchdesk",
        },
      }),
    ).toString("base64url");

    await expect(
      service.list(profile, repository, {
        filter: { state: "open" },
        pageSize: 25,
        pageToken: tokenForSizeTen,
      }),
    ).resolves.toEqual({ _tag: "err", error: "invalid_page" });
  });

  it("rejects a page token minted for a different repository before any GitHub call", async () => {
    const searchMaintainerPullRequests = async (): Promise<never> => {
      throw new Error(
        "GitHub must not receive a token minted for a different repository",
      );
    };
    // SAFETY: test fixture narrows partial collaborators to the exact
    // dependency surface exercised before wrong-repository token rejection.
    const service = new MaintainerInboxService(
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

    // SAFETY: the wrong-repository-token path only reads the profile id and
    // account supplied by this focused fixture.
    const profile = { id: "cfw", ghAccount: "fixture" } as never;

    // Mint a token for a different repository than the one being requested.
    const tokenForAnotherRepository = Buffer.from(
      JSON.stringify({
        state: "open",
        page: 2,
        size: 25,
        repository: {
          host: "github.com",
          owner: "centraldigital",
          repo: "some-other-repo",
        },
      }),
    ).toString("base64url");

    await expect(
      service.list(profile, repository, {
        filter: { state: "open" },
        pageSize: 25,
        pageToken: tokenForAnotherRepository,
      }),
    ).resolves.toEqual({ _tag: "err", error: "invalid_page" });
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
              owner: "centraldigital",
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
    // SAFETY: test fixture narrows a partial mock (only the members
    // MaintainerInboxService actually calls) to its stricter collaborator
    // and profile types.
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        searchMaintainerPullRequests: async () =>
          ok({
            // 12 fixture rows from the one Selected repository — more than
            // the requested page size, proving the service still bounds the
            // page rather than trusting the reader to honor pageSize.
            entries: Array.from({ length: 12 }, (_, index) =>
              summaryAt(
                index + 1,
                `2026-08-${String(12 - index).padStart(2, "0")}T00:00:00.000Z`,
              ),
            ),
            hasNextPage: false,
            issueCount: 12,
          }),
      } as never,
      { listSessions: async () => ok([]) } as never,
      {
        read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
        save: async () => ok(undefined),
      } as never,
      { now: () => "2026-08-01T00:00:00.000Z" as never },
    );

    // SAFETY: this minimal profile supplies exactly the fields list() reads;
    // the one Selected repository returns 12 fixture rows above.
    const profile = { id: "cfw", ghAccount: "fixture" } as never;

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
    const token = JSON.parse(
      Buffer.from(result.value.nextPageToken ?? "", "base64url").toString(
        "utf8",
      ),
    );
    expect(token.size).toBe(10);
  });
});
