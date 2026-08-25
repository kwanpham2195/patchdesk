import { describe, expect, it } from "vitest";

import { MaintainerInboxService } from "../../src/services/maintainer-inbox-service";
import { err, ok, type Result } from "../../src/domain/result";
import { INBOX_CACHE_REFUSE_AFTER_MS } from "../../src/domain/inbox-freshness-policy";
import type { MaintainerInboxCache } from "../../src/adapters/storage/maintainer-inbox-cache-store";
import type { StorageFailure } from "../../src/adapters/storage/json-file";

describe("MaintainerInboxService", () => {
  it("uses saved Review identity as the action authority", async () => {
    // SAFETY: test fixture narrows a partial mock (only the members
    // MaintainerInboxService actually calls) to its stricter collaborator
    // and profile types.
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        listMaintainerPullRequests: async () =>
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
      service.list({
        id: "cfw",
        ghAccount: "fixture",
        repos: [
          { host: "github.com", owner: "centraldigital", repo: "patchdesk" },
        ],
      } as never),
    ).resolves.toMatchObject({
      _tag: "ok",
      value: { rows: [{ recommendedAction: { kind: "run_review" } }] },
    });
  });

  it("reads the merged scope and returns only the terminal action", async () => {
    const scopes: Array<string | undefined> = [];
    // SAFETY: these narrow fixtures implement exactly the service seams under test.
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        listMaintainerPullRequests: async (input: {
          readonly scope?: string;
        }) => {
          scopes.push(input.scope);
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
      {
        id: "cfw",
        ghAccount: "fixture",
        repos: [
          { host: "github.com", owner: "centraldigital", repo: "patchdesk" },
        ],
        // SAFETY: this minimal profile supplies exactly the fields list() reads.
      } as never,
      { scope: "merged", pageSize: 25 },
    );

    expect(scopes).toEqual(["merged"]);
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        scope: "merged",
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

describe("MaintainerInboxService rate-limited reads", () => {
  it("maps a GitHubRateLimited read failure to the github_rate_limited state and carries resumeAt", async () => {
    // SAFETY: test fixture narrows a partial mock (only the members
    // MaintainerInboxService actually calls) to its stricter collaborator
    // and profile types.
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        listMaintainerPullRequests: async () =>
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
      service.list({
        id: "cfw",
        ghAccount: "fixture",
        repos: [
          { host: "github.com", owner: "centraldigital", repo: "patchdesk" },
        ],
      } as never),
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
        listMaintainerPullRequests: async () =>
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
    const result = await service.list({
      id: "cfw",
      ghAccount: "fixture",
      repos: [
        { host: "github.com", owner: "centraldigital", repo: "patchdesk" },
      ],
    } as never);
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
        listMaintainerPullRequests: async () =>
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
    await expect(
      service.list({
        id: "cfw",
        ghAccount: "fixture",
        repos: [
          {
            host: "github.com",
            owner: "OmisePayments",
            repo: "dynamic-onboarding-service",
          },
        ],
      } as never),
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

describe("MaintainerInboxService.cachedOrUnavailable", () => {
  const now = "2026-08-01T04:00:00.000Z";
  // SAFETY: test fixture narrows a partial profile mock to
  // WorkspaceProfileConfig; only the fields the service reads are set.
  const profile = {
    id: "cfw",
    ghAccount: "fixture",
    repos: [{ host: "github.com", owner: "centraldigital", repo: "patchdesk" }],
  } as never;

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
        listMaintainerPullRequests: async () =>
          ok({ entries: [], hasNextPage: false }),
      } as never,
      { listSessions: async () => ok([]) } as never,
      cache as never,
      { now: () => now as never },
    );
  }

  it("marks a cache just under the refuse threshold as failed_cached", async () => {
    const refreshedAt = new Date(
      Date.parse(now) - (INBOX_CACHE_REFUSE_AFTER_MS - 1),
    ).toISOString();
    const service = serviceWithCache({
      read: async () =>
        ok({ schemaVersion: 1, refreshedAt, rows: [], repositories: [] }),
      save: async () => ok(undefined),
    });
    await expect(service.list(profile)).resolves.toMatchObject({
      _tag: "ok",
      value: { snapshot: { state: "failed_cached" } },
    });
  });

  it("marks a cache at the refuse threshold as stale_cached", async () => {
    const refreshedAt = new Date(
      Date.parse(now) - INBOX_CACHE_REFUSE_AFTER_MS,
    ).toISOString();
    const service = serviceWithCache({
      read: async () =>
        ok({ schemaVersion: 1, refreshedAt, rows: [], repositories: [] }),
      save: async () => ok(undefined),
    });
    await expect(service.list(profile)).resolves.toMatchObject({
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
    await expect(service.list(profile)).resolves.toMatchObject({
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
        listMaintainerPullRequests: async () =>
          ok({
            entries: [],
            hasNextPage: true,
            endCursor: "cursor-after-empty-page",
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
    const result = await service.list({
      id: "cfw",
      ghAccount: "fixture",
      repos: [
        { host: "github.com", owner: "centraldigital", repo: "patchdesk" },
      ],
    } as never);

    expect(result._tag).toBe("ok");
    if (result._tag === "err") return;
    expect(result.value.nextPageToken).toBeDefined();
    const token = JSON.parse(
      Buffer.from(result.value.nextPageToken ?? "", "base64url").toString(
        "utf8",
      ),
    );
    expect(token.repositories).toEqual([
      {
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        cursor: "cursor-after-empty-page",
      },
    ]);
  });

  it("rejects malformed tokens before reading GitHub", async () => {
    const listMaintainerPullRequests = async (): Promise<never> => {
      throw new Error("GitHub must not receive malformed inbox tokens");
    };
    // SAFETY: test fixture narrows partial collaborators to the exact
    // dependency surface exercised before malformed-token rejection.
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        listMaintainerPullRequests,
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
        // SAFETY: the malformed-token path only reads the profile id, account,
        // and watched repository identity supplied by this focused fixture.
        {
          id: "cfw",
          ghAccount: "fixture",
          repos: [
            { host: "github.com", owner: "centraldigital", repo: "patchdesk" },
          ],
        } as never,
        { scope: "open", pageSize: 25, pageToken: "not-a-page-token" },
      ),
    ).resolves.toEqual({ _tag: "err", error: "invalid_page" });
  });

  it("rejects a page token whose recorded size does not match the requested size", async () => {
    const listMaintainerPullRequests = async (): Promise<never> => {
      throw new Error("GitHub must not receive a size-mismatched inbox token");
    };
    // SAFETY: test fixture narrows partial collaborators to the exact
    // dependency surface exercised before malformed-token rejection.
    const service = new MaintainerInboxService(
      {
        resolveAuthenticatedAccount: async () =>
          ok({ host: "github.com", account: "fixture" }),
        listMaintainerPullRequests,
      } as never,
      { listSessions: async () => ok([]) } as never,
      {
        read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
        save: async () => ok(undefined),
      } as never,
      { now: () => "2026-08-01T00:00:00.000Z" as never },
    );

    // SAFETY: the malformed-token path only reads the profile id, account,
    // and watched repository identity supplied by this focused fixture.
    const profile = {
      id: "cfw",
      ghAccount: "fixture",
      repos: [
        { host: "github.com", owner: "centraldigital", repo: "patchdesk" },
      ],
    } as never;

    // Mint a token by hand that records a size of 10, then request it back
    // at size 25 — the mismatch must be rejected before any GitHub read.
    const tokenForSizeTen = Buffer.from(
      JSON.stringify({
        scope: "open",
        page: 2,
        size: 10,
        repositories: [
          { host: "github.com", owner: "centraldigital", repo: "patchdesk" },
        ],
      }),
    ).toString("base64url");

    await expect(
      service.list(profile, {
        scope: "open",
        pageSize: 25,
        pageToken: tokenForSizeTen,
      }),
    ).resolves.toEqual({ _tag: "err", error: "invalid_page" });
  });
});

describe("MaintainerInboxService page size", () => {
  it("uses the requested page size as the global page limit when merging repository pages", async () => {
    function summaryAt(
      owner: string,
      repo: string,
      number: number,
      updatedAt: string,
    ) {
      return {
        cursor: `${owner}-${repo}-${number}`,
        pullRequest: {
          summary: {
            ref: { host: "github.com", owner, repo, number },
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
        listMaintainerPullRequests: async (input: {
          readonly repo: { readonly repo: string };
        }) =>
          ok({
            // 6 rows per repository, newest first, so two watched
            // repositories together offer 12 rows — more than any
            // requested page size below.
            entries: Array.from({ length: 6 }, (_, index) =>
              summaryAt(
                "centraldigital",
                input.repo.repo,
                index + 1,
                `2026-08-${String(9 - index).padStart(2, "0")}T00:00:00.000Z`,
              ),
            ),
            hasNextPage: false,
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
    // two watched repositories each return 6 fixture rows above.
    const profile = {
      id: "cfw",
      ghAccount: "fixture",
      repos: [
        { host: "github.com", owner: "centraldigital", repo: "one" },
        { host: "github.com", owner: "centraldigital", repo: "two" },
      ],
    } as never;

    const result = await service.list(profile, {
      scope: "open",
      pageSize: 10,
    });

    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    // 12 fixture rows across the two repositories, truncated to the
    // requested page size of 10 rather than the old fixed 50 or the
    // default 25.
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
