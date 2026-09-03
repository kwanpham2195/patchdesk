import { describe, expect, it } from "vitest";

import { MaintainerInboxService } from "../../src/services/maintainer-inbox-service";
import type { ReviewId, WorkspaceProfileId } from "../../src/domain/ids";
import type {
  InboxInsightKind,
  InboxInsightReadiness,
} from "../../src/domain/maintainer-inbox";
import { ok } from "../../src/domain/result";
import type { parseStoredBrief } from "../../src/domain/stored-brief";

// SAFETY: MaintainerInboxService reads only host/owner/repo off the
// repository parameter; the plain strings stand in for the branded GitHub
// identity types these fixtures never need to parse.
const repository = {
  host: "github.com",
  owner: "centraldigital",
  repo: "patchdesk",
} as never;

/**
 * What one Insight kind's stored record holds: a retained result bound to
 * `headSha` (carrying `value` when the kind's parser should see something
 * other than a well-formed Brief), or a record too corrupt to read at all.
 */
type RetainedFixture =
  | { readonly headSha: string; readonly value?: unknown }
  | "unreadable";

/**
 * The smallest stored Brief `parseStoredBrief` accepts: every block above
 * `snapshot` and `citationStatus` is optional. Its own `snapshot.headSha` is
 * not what readiness compares — that is the retained envelope's revision.
 */
const storedBrief = {
  snapshot: {
    profileId: "cfw",
    sessionId:
      "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__base-bbbbbbbb__abcdef123456",
    headSha: "a".repeat(40),
    patchHash: "d".repeat(64),
  },
  citationStatus: "verified",
};

describe("MaintainerInboxService insight readiness", () => {
  const headSha = "a".repeat(40);
  const earlierHeadSha = "c".repeat(40);
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

  async function rowFor(
    retained: Partial<Record<InboxInsightKind, RetainedFixture>>,
    options: { readonly sessions?: ReadonlyArray<unknown> } = {},
    withStore = true,
  ): Promise<{ readonly insights?: InboxInsightReadiness }> {
    function recordFor(kind: InboxInsightKind) {
      const fixture = retained[kind];
      if (fixture === "unreadable")
        return {
          _tag: "err" as const,
          error: { reason: "invalid_stored_value" },
        };
      return ok(
        fixture === undefined
          ? {}
          : {
              retained: {
                revision: { headSha: fixture.headSha },
                value: fixture.value ?? storedBrief,
              },
            },
      );
    }
    const insights = {
      load: async (
        _profileId: WorkspaceProfileId,
        _reviewId: ReviewId,
        kind: InboxInsightKind,
      ) => recordFor(kind),
      // Mirrors the real store: the caller's parser runs against the stored
      // value, and a value it rejects makes the whole read invalid. Typing the
      // parameter as `parseStoredBrief` is the assertion that the service
      // hands the Brief its own parser and not some looser one.
      loadTyped: async (
        _profileId: WorkspaceProfileId,
        _reviewId: ReviewId,
        kind: InboxInsightKind,
        parseRetainedValue: typeof parseStoredBrief,
      ) => {
        const record = recordFor(kind);
        if (record._tag === "err") return record;
        const stored = record.value.retained;
        if (stored === undefined) return record;
        return parseRetainedValue(stored.value)._tag === "err"
          ? {
              _tag: "err" as const,
              error: { reason: "invalid_stored_value" },
            }
          : record;
      },
    };
    // SAFETY: these narrow fixtures implement exactly the service seams under test.
    const service = new MaintainerInboxService(
      github as never,
      {
        listSessions: async () => ok(options.sessions ?? [session]),
      } as never,
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

  it("reads a Brief bound to the row's current head as ready", async () => {
    expect((await rowFor({ brief: { headSha } })).insights).toEqual({
      brief: "ready",
    });
  });

  it("reads a Brief bound to an earlier head as outdated", async () => {
    expect(
      (await rowFor({ brief: { headSha: earlierHeadSha } })).insights,
    ).toEqual({
      brief: "outdated",
    });
  });

  it("reports every kind the review retains in one row", async () => {
    expect(
      (
        await rowFor({
          brief: { headSha },
          analysis: { headSha },
          walkthrough: { headSha: earlierHeadSha },
        })
      ).insights,
    ).toEqual({
      brief: "ready",
      analysis: "ready",
      walkthrough: "outdated",
    });
  });

  it("keeps one unreadable record from hiding the kinds beside it", async () => {
    expect(
      (
        await rowFor({
          brief: "unreadable",
          analysis: { headSha },
          walkthrough: { headSha: earlierHeadSha },
        })
      ).insights,
    ).toEqual({ analysis: "ready", walkthrough: "outdated" });
  });

  it("claims no Brief whose stored value no longer parses, and still reads Analysis beside it", async () => {
    expect(
      (
        await rowFor({
          brief: { headSha, value: { snapshot: "not a stored Brief" } },
          analysis: { headSha },
        })
      ).insights,
    ).toEqual({ analysis: "ready" });
  });

  it("carries no readiness when the review retains nothing", async () => {
    expect((await rowFor({})).insights).toBeUndefined();
  });

  it("carries no readiness when Patchdesk holds no session for the row", async () => {
    expect(
      (await rowFor({ brief: { headSha } }, { sessions: [] })).insights,
    ).toBeUndefined();
  });

  it("carries no readiness when no Insight store is wired in", async () => {
    expect(
      (await rowFor({ brief: { headSha } }, {}, false)).insights,
    ).toBeUndefined();
  });

  it("reads the review's records through a session at an earlier head", async () => {
    const staleSession = {
      ...session,
      key: { ...session.key, headSha: earlierHeadSha },
    };
    expect(
      (await rowFor({ brief: { headSha } }, { sessions: [staleSession] }))
        .insights,
    ).toEqual({ brief: "ready" });
  });
});
