import { describe, expect, it, vi } from "vitest";

import type { ReviewStore } from "../../src/adapters/storage/review-store";
import { definedProps } from "../../src/domain/defined-props";
import {
  parseAbsolutePath,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parseLocalBranchName,
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
import {
  SidebarListingService,
  type SidebarListing,
} from "../../src/services/sidebar-listing-service";

type ListResult = Awaited<ReturnType<ReviewStore["list"]>>;
type DiagnosticInput = Parameters<ReviewDiagnosticService["record"]>[0];
type DiagnosticResult = Awaited<ReturnType<ReviewDiagnosticService["record"]>>;

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("Invalid fixture");
  return result.value;
}

const profileId = must(parseWorkspaceProfileId("acme"));
const headSha = must(parseGitSha("1".repeat(40)));
const baseSha = must(parseGitSha("b".repeat(40)));
const createdAt = must(parseIsoTimestamp("2026-01-01T00:00:00.000Z"));
const host = must(parseGitHubHost("github.com"));
const owner = must(parseGitHubOwner("octo-org"));
const repo = must(parseGitHubRepoName("patchdesk"));

/** One stored Review per pull request number, with the timestamps under test. */
function review(input: {
  readonly number: number;
  readonly updatedAt: string;
  readonly lastOpenedAt?: string;
  readonly title?: string;
  readonly terminal?: {
    readonly state: "merged" | "closed";
    readonly observedAt: string;
  };
}): Review {
  const identity: ReviewIdentity = {
    profileId,
    host,
    owner,
    repo,
    source: {
      kind: "pull_request",
      prNumber: must(parsePullRequestNumber(input.number)),
    },
  };
  const base = createReview({
    identity,
    currentSessionId: createReviewSessionId({ ...identity, headSha, baseSha }),
    headSha,
    createdAt,
  });
  // `createReview` leaves the Review Open, which is the other case under test.
  const status: Review["status"] =
    input.terminal === undefined
      ? { _tag: "Open" }
      : {
          _tag: "Terminal",
          state: input.terminal.state,
          observedAt: must(parseIsoTimestamp(input.terminal.observedAt)),
        };
  return {
    ...base,
    updatedAt: must(parseIsoTimestamp(input.updatedAt)),
    status,
    ...definedProps({
      lastOpenedAt:
        input.lastOpenedAt === undefined
          ? undefined
          : must(parseIsoTimestamp(input.lastOpenedAt)),
      title: input.title,
    }),
  };
}

/** A working-tree Review on `branch`, or a branch Review against main, opened at `lastOpenedAt`. */
function localReview(
  branch: string,
  lastOpenedAt: string,
  options: {
    readonly kind?: "working_tree" | "branch";
    readonly repo?: string;
    readonly checkout?: string;
  } = {},
): Review {
  const branchName = must(parseLocalBranchName(branch));
  const checkout = definedProps({
    checkout:
      options.checkout === undefined
        ? undefined
        : must(parseAbsolutePath(options.checkout)),
  });
  const identity: ReviewIdentity = {
    profileId,
    host,
    owner,
    repo: must(parseGitHubRepoName(options.repo ?? "patchdesk")),
    source:
      options.kind === "branch"
        ? {
            kind: "branch",
            branch: branchName,
            baseBranch: must(parseLocalBranchName("main")),
            ...checkout,
          }
        : { kind: "working_tree", branch: branchName, ...checkout },
  };
  return {
    ...createReview({
      identity,
      currentSessionId: createReviewSessionId({
        ...identity,
        headSha,
        baseSha,
      }),
      headSha,
      createdAt,
    }),
    updatedAt: createdAt,
    lastOpenedAt: must(parseIsoTimestamp(lastOpenedAt)),
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

/** The pull request numbers of the listed rows; a local row lists none. */
function numbers(
  rows: SidebarListing["rows"],
): ReadonlyArray<number | undefined> {
  return rows.map((row) => ("number" in row ? row.number : undefined));
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
    expect(listing.rows.map((row) => row.sortedAt)).toEqual([
      "2026-04-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
      "2026-02-15T00:00:00.000Z",
      "2026-01-15T00:00:00.000Z",
    ]);
  });

  it("projects the recorded open of a record that has one", async () => {
    const value = service(
      ok({
        reviews: [
          review({
            number: 21,
            updatedAt: "2026-04-01T00:00:00.000Z",
            lastOpenedAt: "2026-03-01T00:00:00.000Z",
          }),
        ],
        unreadable: 0,
      }),
    );

    const listing = must(await value.listed.list(profileId));

    expect(listing.rows.at(0)).toMatchObject({
      lastOpenedAt: "2026-03-01T00:00:00.000Z",
      sortedAt: "2026-03-01T00:00:00.000Z",
    });
  });

  it("omits the recorded open of a record that has none, keeping the sort instant", async () => {
    const value = service(
      ok({
        reviews: [
          review({ number: 22, updatedAt: "2026-04-01T00:00:00.000Z" }),
        ],
        unreadable: 0,
      }),
    );

    const listing = must(await value.listed.list(profileId));

    // `updatedAt` is GitHub's activity, not a visit: it may order the row but
    // must not reach it as a recorded open.
    expect(Object.hasOwn(listing.rows.at(0) ?? {}, "lastOpenedAt")).toBe(false);
    expect(listing.rows.at(0)).toMatchObject({
      sortedAt: "2026-04-01T00:00:00.000Z",
    });
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

  it("projects a repository's local Reviews as one row, whatever their branch or source, beside an unchanged pull request row", async () => {
    const mainTree = localReview("main", "2026-03-01T00:00:00.000Z");
    const featTree = localReview("feat/x", "2026-03-03T00:00:00.000Z");
    const featBranch = localReview("feat/x", "2026-03-02T00:00:00.000Z", {
      kind: "branch",
    });
    const value = service(
      ok({
        reviews: [
          mainTree,
          review({
            number: 7,
            updatedAt: createdAt,
            lastOpenedAt: "2026-03-04T00:00:00.000Z",
            title: "Add the sidebar",
          }),
          featTree,
          featBranch,
        ],
        unreadable: 0,
      }),
    );

    const listing = must(await value.listed.list(profileId));

    expect(listing.rows).toHaveLength(2);
    expect(listing.rows.at(0)).toMatchObject({
      number: 7,
      title: "Add the sidebar",
      lastOpenedAt: "2026-03-04T00:00:00.000Z",
    });
    const local = listing.rows.at(1);
    expect(local).toMatchObject({
      host: "github.com",
      owner: "octo-org",
      repo: "patchdesk",
      lastOpenedAt: "2026-03-03T00:00:00.000Z",
      sortedAt: "2026-03-03T00:00:00.000Z",
    });
    expect(
      local !== undefined && "reviewIds" in local
        ? [...local.reviewIds].sort()
        : [],
    ).toEqual([featBranch.id, featTree.id, mainTree.id].sort());
    // The row names no source and no branch: the checkout decides that at the click.
    expect(Object.hasOwn(local ?? {}, "source")).toBe(false);
    expect(Object.hasOwn(local ?? {}, "number")).toBe(false);
  });

  it("projects each checkout of a repository as its own local row, naming only the linked one (#489)", async () => {
    const configured = localReview("main", "2026-03-01T00:00:00.000Z");
    const linked = localReview("feat", "2026-03-02T00:00:00.000Z", {
      checkout: "/work/pd-ux-pass",
    });
    const linkedBranch = localReview("feat", "2026-03-03T00:00:00.000Z", {
      kind: "branch",
      checkout: "/work/pd-ux-pass",
    });
    const value = service(
      ok({ reviews: [configured, linked, linkedBranch], unreadable: 0 }),
    );

    const { rows } = must(await value.listed.list(profileId));

    expect(rows).toHaveLength(2);
    expect(rows.at(0)).toMatchObject({
      checkout: "/work/pd-ux-pass",
      checkoutName: "pd-ux-pass",
      reviewIds: expect.arrayContaining([linked.id, linkedBranch.id]),
    });
    expect(rows.at(1)).toMatchObject({ reviewIds: [configured.id] });
    expect(Object.hasOwn(rows.at(1) ?? {}, "checkout")).toBe(false);
  });

  it("counts each repository's local row once toward the twenty-row cap", async () => {
    const day = (value: number): string =>
      `2026-06-${String(value).padStart(2, "0")}T00:00:00.000Z`;
    const pullRequests = Array.from({ length: 21 }, (_unused, index) =>
      review({
        number: index + 1,
        updatedAt: createdAt,
        lastOpenedAt: day(index + 1),
      }),
    );
    const reviews = [
      ...pullRequests,
      localReview("a-1", day(22)),
      localReview("a-2", day(23)),
      localReview("a-3", day(30)),
      localReview("b-1", day(24), { repo: "herdr" }),
      localReview("b-2", day(25), { repo: "herdr" }),
    ];
    const value = service(ok({ reviews, unreadable: 0 }));

    const listing = must(await value.listed.list(profileId));

    // Two local rows, then the eighteen newest pull requests, #21 down to #4.
    expect(listing.rows).toHaveLength(20);
    expect(listing.rows.slice(0, 2)).toMatchObject([
      { repo: "patchdesk", sortedAt: day(30) },
      { repo: "herdr", sortedAt: day(25) },
    ]);
    expect(numbers(listing.rows.slice(2))).toEqual(
      Array.from({ length: 18 }, (_unused, index) => 21 - index),
    );
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

  it("projects the state a terminal Review reached and when it was observed", async () => {
    const value = service(
      ok({
        reviews: [
          review({
            number: 11,
            updatedAt: "2026-03-01T00:00:00.000Z",
            terminal: {
              state: "merged",
              observedAt: "2026-02-20T08:30:00.000Z",
            },
          }),
          review({
            number: 12,
            updatedAt: "2026-02-01T00:00:00.000Z",
            terminal: {
              state: "closed",
              observedAt: "2026-01-18T11:00:00.000Z",
            },
          }),
        ],
        unreadable: 0,
      }),
    );

    const listing = must(await value.listed.list(profileId));

    expect(
      listing.rows.map((row) => ("terminal" in row ? row.terminal : undefined)),
    ).toEqual([
      { state: "merged", observedAt: "2026-02-20T08:30:00.000Z" },
      { state: "closed", observedAt: "2026-01-18T11:00:00.000Z" },
    ]);
  });

  it("omits the terminal key for a Review that is still open", async () => {
    const value = service(
      ok({
        reviews: [
          review({ number: 13, updatedAt: "2026-03-01T00:00:00.000Z" }),
        ],
        unreadable: 0,
      }),
    );

    const listing = must(await value.listed.list(profileId));

    expect(Object.hasOwn(listing.rows.at(0) ?? {}, "terminal")).toBe(false);
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
