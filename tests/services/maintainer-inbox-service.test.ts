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
            pullRequests: [
              {
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
            ],
            complete: true,
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

describe("MaintainerInboxService.cachedOrUnavailable", () => {
  const now = "2026-08-01T04:00:00.000Z";
  // SAFETY: test fixture narrows a partial profile mock to
  // WorkspaceProfileConfig; only the fields the service reads are set.
  const profile = {
    id: "cfw",
    ghAccount: "fixture",
    repos: [
      { host: "github.com", owner: "centraldigital", repo: "patchdesk" },
    ],
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
          ok({ pullRequests: [], complete: true }),
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
