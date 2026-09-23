import { describe, expect, it } from "vitest";

import { MaintainerInboxService } from "../../src/services/maintainer-inbox-service";
import { ok } from "../../src/domain/result";

// SAFETY: MaintainerInboxService reads only host/owner/repo from this fixture.
const repository = {
  host: "github.com",
  owner: "octo-org",
  repo: "patchdesk",
} as never;

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
      { id: "acme", ghAccount: "fixture" } as never,
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
      owner: "octo-org",
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
        { id: "acme", ghAccount: "fixture" } as never,
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
    const profile = { id: "acme", ghAccount: "fixture" } as never;

    // Mint a token by hand that records a size of 10, then request it back
    // at size 25 — the mismatch must be rejected before any GitHub read.
    const tokenForSizeTen = Buffer.from(
      JSON.stringify({
        state: "open",
        page: 2,
        size: 10,
        repository: {
          host: "github.com",
          owner: "octo-org",
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
    const profile = { id: "acme", ghAccount: "fixture" } as never;

    // Mint a token for a different repository than the one being requested.
    const tokenForAnotherRepository = Buffer.from(
      JSON.stringify({
        state: "open",
        page: 2,
        size: 25,
        repository: {
          host: "github.com",
          owner: "octo-org",
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
    const profile = { id: "acme", ghAccount: "fixture" } as never;

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
