import { describe, expect, it } from "vitest";

import { MaintainerInboxService } from "../../src/services/maintainer-inbox-service";
import { ok } from "../../src/domain/result";

// SAFETY: MaintainerInboxService reads only host/owner/repo off the
// repository parameter; the plain strings stand in for the branded GitHub
// identity types these fixtures never need to parse.
const repository = {
  host: "github.com",
  owner: "centraldigital",
  repo: "patchdesk",
} as never;

describe("MaintainerInboxService brief tag", () => {
  const headSha = "a".repeat(40);
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
            cursor: "brief-42",
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

  /** `retainedHeadSha` undefined stands for "no Brief retained at all". */
  async function rowFor(
    retainedHeadSha: string | undefined,
    withStore = true,
  ): Promise<{ readonly briefReady?: true }> {
    const insights = {
      loadTyped: async () =>
        ok(
          retainedHeadSha === undefined
            ? {}
            : { retained: { revision: { headSha: retainedHeadSha } } },
        ),
    };
    // SAFETY: these narrow fixtures implement exactly the service seams under test.
    const service = new MaintainerInboxService(
      github as never,
      { listSessions: async () => ok([session]) } as never,
      {
        read: async () => ({ _tag: "err", error: { reason: "not_found" } }),
        save: async () => ok(undefined),
      } as never,
      { now: () => "2026-08-01T00:00:00.000Z" as never },
      ...(withStore ? [insights as never] : []),
    );
    const listed = await service.list(
      { id: "cfw", ghAccount: "fixture" } as never,
      repository,
    );
    if (listed._tag === "err") throw new Error("expected an inbox page");
    const row = listed.value.rows[0];
    if (row === undefined) throw new Error("expected one row");
    return row;
  }

  it("tags a row whose retained Brief is bound to its current head", async () => {
    expect((await rowFor(headSha)).briefReady).toBe(true);
  });

  it("leaves the tag off when the retained Brief is for an earlier head", async () => {
    expect((await rowFor("c".repeat(40))).briefReady).toBeUndefined();
  });

  it("leaves the tag off when no Brief is retained for the review", async () => {
    expect((await rowFor(undefined)).briefReady).toBeUndefined();
  });

  it("leaves the tag off when no Insight store is wired in", async () => {
    expect((await rowFor(headSha, false)).briefReady).toBeUndefined();
  });
});
