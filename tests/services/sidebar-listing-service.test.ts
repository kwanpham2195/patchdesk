import { describe, expect, it, vi } from "vitest";

import type { ReviewStore } from "../../src/adapters/storage/review-store";
import { definedProps } from "../../src/domain/defined-props";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parsePullRequestNumber,
  parseWorkspaceProfileId,
  createReviewSessionId,
} from "../../src/domain/ids";
import { ok, type Result } from "../../src/domain/result";
import {
  createReview,
  type Review,
  type ReviewIdentity,
} from "../../src/domain/review";
import type { ReviewDiagnosticService } from "../../src/services/review-diagnostic-service";
import { SidebarListingService } from "../../src/services/sidebar-listing-service";

type ListResult = Awaited<ReturnType<ReviewStore["list"]>>;
type DiagnosticInput = Parameters<ReviewDiagnosticService["record"]>[0];
type DiagnosticResult = Awaited<ReturnType<ReviewDiagnosticService["record"]>>;

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("Invalid fixture");
  return result.value;
}

const profileId = must(parseWorkspaceProfileId("cfw"));
const headSha = must(parseGitSha("1".repeat(40)));
const baseSha = must(parseGitSha("b".repeat(40)));
const createdAt = must(parseIsoTimestamp("2026-01-01T00:00:00.000Z"));
const host = must(parseGitHubHost("github.com"));
const owner = must(parseGitHubOwner("centraldigital"));
const repo = must(parseGitHubRepoName("patchdesk"));

/** One stored Review per pull request number, with the timestamps under test. */
function review(input: {
  readonly number: number;
  readonly updatedAt: string;
  readonly lastOpenedAt?: string;
  readonly title?: string;
}): Review {
  const identity: ReviewIdentity = {
    profileId,
    host,
    owner,
    repo,
    prNumber: must(parsePullRequestNumber(input.number)),
  };
  const base = createReview({
    identity,
    currentSessionId: createReviewSessionId({ ...identity, headSha, baseSha }),
    headSha,
    createdAt,
  });
  return {
    ...base,
    updatedAt: must(parseIsoTimestamp(input.updatedAt)),
    ...definedProps({
      lastOpenedAt:
        input.lastOpenedAt === undefined
          ? undefined
          : must(parseIsoTimestamp(input.lastOpenedAt)),
      title: input.title,
    }),
  };
}

function service(listing: ListResult) {
  const recorded: DiagnosticInput[] = [];
  const record = vi.fn(
    async (input: DiagnosticInput): Promise<DiagnosticResult> => {
      recorded.push(input);
      return ok({
        schemaVersion: 1,
        incidentId: "incident",
        at: createdAt,
        category: input.category,
        phase: input.phase,
        profileId,
        retryable: input.retryable,
      });
    },
  );
  const listed = new SidebarListingService({
    reviews: {
      async list(): Promise<ListResult> {
        return listing;
      },
    },
    diagnostics: { record },
  });
  return { listed, recorded };
}

function numbers(rows: ReadonlyArray<{ readonly number: number }>): number[] {
  return rows.map((row) => row.number);
}

describe("SidebarListingService.list", () => {
  it("sorts by lastOpenedAt, falling back to updatedAt for a record that has none", async () => {
    const value = service(
      ok({
        reviews: [
          review({
            number: 1,
            updatedAt: "2026-02-01T00:00:00.000Z",
            lastOpenedAt: "2026-03-01T00:00:00.000Z",
          }),
          review({ number: 2, updatedAt: "2026-04-01T00:00:00.000Z" }),
          review({
            number: 3,
            updatedAt: "2026-05-01T00:00:00.000Z",
            lastOpenedAt: "2026-01-15T00:00:00.000Z",
          }),
          review({ number: 4, updatedAt: "2026-02-15T00:00:00.000Z" }),
        ],
        unreadable: 0,
      }),
    );

    const listing = must(await value.listed.list(profileId));

    expect(numbers(listing.rows)).toEqual([2, 1, 4, 3]);
    expect(listing.rows.map((row) => row.openedAt)).toEqual([
      "2026-04-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
      "2026-02-15T00:00:00.000Z",
      "2026-01-15T00:00:00.000Z",
    ]);
  });

  it("keeps the twenty most recently opened pull requests", async () => {
    const reviews = Array.from({ length: 25 }, (_unused, index) =>
      review({
        number: index + 1,
        updatedAt: createdAt,
        lastOpenedAt: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
    const value = service(ok({ reviews, unreadable: 0 }));

    const listing = must(await value.listed.list(profileId));

    expect(listing.rows).toHaveLength(20);
    expect(numbers(listing.rows).at(0)).toBe(25);
    expect(numbers(listing.rows).at(-1)).toBe(6);
  });

  it("records a diagnostic for unreadable records and still returns the readable rows", async () => {
    const value = service(
      ok({
        reviews: [review({ number: 7, updatedAt: "2026-03-01T00:00:00.000Z" })],
        unreadable: 2,
      }),
    );

    const listing = must(await value.listed.list(profileId));

    expect(numbers(listing.rows)).toEqual([7]);
    expect(listing.unreadable).toBe(2);
    expect(value.recorded).toEqual([
      {
        profileId,
        category: "recovery",
        phase: "sidebar-listing-unreadable",
        retryable: true,
        detail: "unreadable_reviews=2",
      },
    ]);
  });

  it("records nothing when every stored Review is readable", async () => {
    const value = service(
      ok({
        reviews: [review({ number: 7, updatedAt: "2026-03-01T00:00:00.000Z" })],
        unreadable: 0,
      }),
    );

    await value.listed.list(profileId);

    expect(value.recorded).toEqual([]);
  });

  it("survives a diagnostic that rejects", async () => {
    const listed = new SidebarListingService({
      reviews: {
        async list(): Promise<ListResult> {
          return ok({
            reviews: [
              review({ number: 7, updatedAt: "2026-03-01T00:00:00.000Z" }),
            ],
            unreadable: 1,
          });
        },
      },
      diagnostics: {
        record: async (): Promise<DiagnosticResult> => {
          throw new Error("diagnostics unavailable");
        },
      },
    });

    const listing = must(await listed.list(profileId));

    expect(numbers(listing.rows)).toEqual([7]);
  });

  it("omits the title key for a record that has no title", async () => {
    const value = service(
      ok({
        reviews: [
          review({
            number: 7,
            updatedAt: "2026-03-01T00:00:00.000Z",
            title: "Add the sidebar",
          }),
          review({ number: 8, updatedAt: "2026-02-01T00:00:00.000Z" }),
        ],
        unreadable: 0,
      }),
    );

    const listing = must(await value.listed.list(profileId));

    expect(listing.rows.at(0)).toMatchObject({ title: "Add the sidebar" });
    expect(Object.hasOwn(listing.rows.at(1) ?? {}, "title")).toBe(false);
  });

  it("omits the title key for a record whose stored title is empty", async () => {
    const value = service(
      ok({
        reviews: [
          review({
            number: 9,
            updatedAt: "2026-03-01T00:00:00.000Z",
            title: "",
          }),
        ],
        unreadable: 0,
      }),
    );

    const listing = must(await value.listed.list(profileId));

    expect(Object.hasOwn(listing.rows.at(0) ?? {}, "title")).toBe(false);
  });

  it("reports a failed listing as a storage failure", async () => {
    const value = service({
      _tag: "err",
      error: { _tag: "StorageFailure", operation: "read", reason: "io" },
    });

    const listing = await value.listed.list(profileId);

    expect(listing).toEqual({ _tag: "err", error: { reason: "storage" } });
  });
});
