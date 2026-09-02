// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  firstInboxRequest,
  firstInboxRequestFor,
  inboxRequestPath,
  nextInboxRequest,
  reconcileInboxRepository,
  resolveInboxRepository,
  sameInboxRows,
  type InboxRequestState,
} from "../../src/renderer/src/inbox-request";
import {
  loadInboxViewPreferences,
  saveInboxViewPreferences,
} from "../../src/renderer/src/inbox-view-preferences";
import type { Profile, Repo } from "../../src/renderer/src/renderer-models";

const repoA: Repo = { host: "github.com", owner: "owner-a", repo: "repo-a" };
const repoB: Repo = { host: "github.com", owner: "owner-b", repo: "repo-b" };

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "profile",
    label: "Profile",
    githubHost: "github.com",
    ghAccount: "fixture",
    ...overrides,
  };
}

function request(
  overrides: Partial<InboxRequestState> = {},
): InboxRequestState {
  return { ...firstInboxRequest, ...overrides };
}

afterEach(() => {
  window.localStorage.clear();
});

describe("inboxRequestPath", () => {
  it("sends the state filter and page size on the bootstrap request, and no repository", () => {
    expect(inboxRequestPath(firstInboxRequest)).toBe(
      "/v1/inbox?state=open&pageSize=25",
    );
  });

  it("splits the selected repository into its host, owner, and repo qualifiers", () => {
    expect(inboxRequestPath(request({ repository: repoA }))).toBe(
      "/v1/inbox?state=open&pageSize=25&host=github.com&owner=owner-a&repo=repo-a",
    );
  });

  it("repeats one label qualifier per selected label, in the order chosen", () => {
    const path = inboxRequestPath(
      request({ selectedLabels: ["bug", "needs triage"] }),
    );
    expect(path).toBe(
      "/v1/inbox?state=open&pageSize=25&label=bug&label=needs+triage",
    );
  });

  it("omits the awaitingMyReview qualifier unless the preset is on (ADR 0031)", () => {
    expect(
      inboxRequestPath(request({ awaitingMyReview: false })),
    ).not.toContain("awaitingMyReview");
    expect(inboxRequestPath(request({ awaitingMyReview: true }))).toContain(
      "awaitingMyReview=1",
    );
  });

  it("serializes selected review state and check status only when selected", () => {
    expect(
      inboxRequestPath(
        request({ reviewState: "approved", checkStatus: "failure" }),
      ),
    ).toBe(
      "/v1/inbox?state=open&pageSize=25&reviewState=approved&checkStatus=failure",
    );
    expect(inboxRequestPath(request())).not.toContain("reviewState");
    expect(inboxRequestPath(request())).not.toContain("checkStatus");
  });

  it("serializes the author and base branch only when set, under the route's own names", () => {
    expect(
      inboxRequestPath(request({ author: "@me", baseBranch: "main" })),
    ).toBe("/v1/inbox?state=open&pageSize=25&author=%40me&base=main");
    expect(inboxRequestPath(request())).not.toContain("author");
    expect(inboxRequestPath(request())).not.toContain("base=");
  });

  it("sends the page cursor opaquely, without decoding or re-encoding its parts", () => {
    // The cursor is minted by the main process; the renderer must round-trip
    // it as one string, so an encoded cursor survives percent-encoding once.
    const path = inboxRequestPath(request({ pageToken: "cursor/one+two" }));
    expect(path).toContain("page=cursor%2Fone%2Btwo");
    const value = new URL(path, "http://localhost").searchParams.get("page");
    expect(value).toBe("cursor/one+two");
  });

  it("carries a non-default state filter and page size", () => {
    expect(
      inboxRequestPath(request({ state: "merged", pageSize: 10 })),
    ).toContain("state=merged&pageSize=10");
  });
});

describe("nextInboxRequest", () => {
  it("carries over every field the caller does not name", () => {
    const current = request({
      repository: repoA,
      state: "merged",
      pageSize: 10,
      selectedLabels: ["bug"],
      awaitingMyReview: true,
    });
    expect(nextInboxRequest(current)).toEqual({
      repository: repoA,
      state: "merged",
      pageSize: 10,
      selectedLabels: ["bug"],
      awaitingMyReview: true,
      previousPageTokens: [],
    });
  });

  it("clears review and check filters only when their override keys are present", () => {
    const current = request({
      reviewState: "approved",
      checkStatus: "failure",
    });
    expect(nextInboxRequest(current)).toMatchObject({
      reviewState: "approved",
      checkStatus: "failure",
    });
    const cleared = nextInboxRequest(current, {
      reviewState: undefined,
      checkStatus: undefined,
    });
    expect(cleared).not.toHaveProperty("reviewState");
    expect(cleared).not.toHaveProperty("checkStatus");
  });

  it("clears the author and base branch only when their override keys are present", () => {
    const current = request({ author: "octocat", baseBranch: "main" });
    expect(nextInboxRequest(current)).toMatchObject({
      author: "octocat",
      baseBranch: "main",
    });
    expect(nextInboxRequest(current, { state: "merged" })).toMatchObject({
      author: "octocat",
      baseBranch: "main",
    });
    const cleared = nextInboxRequest(current, {
      author: undefined,
      baseBranch: undefined,
    });
    expect(cleared).not.toHaveProperty("author");
    expect(cleared).not.toHaveProperty("baseBranch");
  });

  it("drops the page cursor for every change that is not itself a page move", () => {
    const onPageTwo = request({
      repository: repoA,
      pageToken: "page-1",
      previousPageTokens: [undefined],
    });
    // A cursor minted under a different repository, state, page size, or
    // label filter belongs to a different GitHub search and is rejected as
    // `invalid_page`, so carrying it forward could only fail the read.
    for (const change of [
      { repository: repoB },
      { state: "merged" as const },
      { pageSize: 10 as const },
      { selectedLabels: ["bug"] },
      { awaitingMyReview: true },
      { reviewState: "approved" as const },
      { checkStatus: "failure" as const },
      { author: "octocat" },
      { baseBranch: "main" },
    ]) {
      const next = nextInboxRequest(onPageTwo, change);
      expect(next.pageToken).toBeUndefined();
      expect(next.previousPageTokens).toEqual([]);
    }
  });

  it("keeps the cursor the two paging callers name themselves", () => {
    const next = nextInboxRequest(request({ repository: repoA }), {
      pageToken: "page-2",
      previousPageTokens: [undefined, "page-1"],
    });
    expect(next.pageToken).toBe("page-2");
    expect(next.previousPageTokens).toEqual([undefined, "page-1"]);
  });

  it("clears the repository when the key is named as undefined, and keeps it when the key is absent", () => {
    const current = request({ repository: repoA });
    expect(
      nextInboxRequest(current, { repository: undefined }).repository,
    ).toBe(undefined);
    expect(nextInboxRequest(current, { state: "merged" }).repository).toEqual(
      repoA,
    );
  });
});

describe("sameInboxRows", () => {
  it("is true for two requests that ask GitHub for the same rows", () => {
    expect(
      sameInboxRows(
        request({ repository: repoA, selectedLabels: ["bug"] }),
        request({ repository: { ...repoA }, selectedLabels: ["bug"] }),
      ),
    ).toBe(true);
  });

  it("is false for each field that changes the answer, including the ones the response never echoes", () => {
    const base = request({ repository: repoA, selectedLabels: ["bug"] });
    const changes: ReadonlyArray<Partial<InboxRequestState>> = [
      { repository: repoB },
      { state: "merged" },
      { pageSize: 10 },
      { awaitingMyReview: true },
      { reviewState: "approved" },
      { checkStatus: "failure" },
      { author: "octocat" },
      { baseBranch: "main" },
      { pageToken: "page-1" },
      { selectedLabels: ["bug", "chore"] },
      { selectedLabels: ["chore"] },
      { selectedLabels: [] },
    ];
    for (const change of changes) {
      expect(sameInboxRows(base, { ...base, ...change })).toBe(false);
    }
  });
});

describe("resolveInboxRepository", () => {
  it("keeps the stored repository while it is still watched", () => {
    expect(resolveInboxRepository([repoA, repoB], repoB)).toEqual(repoB);
  });

  it("falls back to the first watched repository when the stored one is gone", () => {
    expect(
      resolveInboxRepository([repoA, repoB], {
        host: "github.com",
        owner: "removed-owner",
        repo: "removed-repo",
      }),
    ).toEqual(repoA);
  });

  it("resolves to nothing when the watchlist is empty", () => {
    expect(resolveInboxRepository([], repoA)).toBeUndefined();
  });
});

describe("firstInboxRequestFor", () => {
  it("guesses from the first profile's stored view preferences", () => {
    saveInboxViewPreferences("profile", {
      state: "merged",
      pageSize: 10,
      selectedLabels: ["bug"],
      awaitingMyReview: true,
      reviewState: "approved",
      checkStatus: "failure",
      author: "octocat",
      baseBranch: "main",
    });
    expect(firstInboxRequestFor([profile()])).toEqual({
      state: "merged",
      pageSize: 10,
      selectedLabels: ["bug"],
      awaitingMyReview: true,
      reviewState: "approved",
      checkStatus: "failure",
      author: "octocat",
      baseBranch: "main",
      previousPageTokens: [],
    });
  });

  it("leaves the repository unset, since a repository outside the true active profile's watchlist fails the whole request", () => {
    saveInboxViewPreferences("profile", { selectedRepository: repoA });
    expect(firstInboxRequestFor([profile()]).repository).toBeUndefined();
  });

  it("falls back to the bootstrap request when no profile is known yet", () => {
    expect(firstInboxRequestFor([])).toEqual(firstInboxRequest);
  });
});

describe("reconcileInboxRepository", () => {
  it("replaces a repository the active profile no longer watches, resetting the cursor and label filter", () => {
    saveInboxViewPreferences("profile", { selectedRepository: repoB });
    const base = request({
      repository: repoB,
      selectedLabels: ["bug"],
      pageToken: "page-1",
      previousPageTokens: [undefined],
    });
    const next = reconcileInboxRepository(
      base,
      [profile({ repos: [repoA] })],
      "profile",
    );
    expect(next.repository).toEqual(repoA);
    expect(next.selectedLabels).toEqual([]);
    expect(next.pageToken).toBeUndefined();
    expect(next.previousPageTokens).toEqual([]);
    expect(loadInboxViewPreferences("profile").selectedRepository).toEqual(
      repoA,
    );
    expect(loadInboxViewPreferences("profile").selectedLabels).toEqual([]);
  });

  it("carries review and check filters across repository changes while clearing labels", () => {
    saveInboxViewPreferences("profile", {
      selectedRepository: repoB,
      selectedLabels: ["bug"],
      reviewState: "approved",
      checkStatus: "failure",
    });
    const base = request({
      repository: repoB,
      selectedLabels: ["bug"],
      reviewState: "approved",
      checkStatus: "failure",
    });
    const next = reconcileInboxRepository(
      base,
      [profile({ repos: [repoA] })],
      "profile",
    );
    expect(next.selectedLabels).toEqual([]);
    expect(next.reviewState).toBe("approved");
    expect(next.checkStatus).toBe("failure");
  });

  it("carries the author and base branch across repository changes while clearing labels", () => {
    saveInboxViewPreferences("profile", {
      selectedRepository: repoB,
      selectedLabels: ["bug"],
      author: "octocat",
      baseBranch: "main",
    });
    const base = request({
      repository: repoB,
      selectedLabels: ["bug"],
      author: "octocat",
      baseBranch: "main",
    });
    const next = reconcileInboxRepository(
      base,
      [profile({ repos: [repoA] })],
      "profile",
    );
    expect(next.selectedLabels).toEqual([]);
    expect(next.author).toBe("octocat");
    expect(next.baseBranch).toBe("main");
  });

  it("returns the request untouched when the repository is still watched", () => {
    saveInboxViewPreferences("profile", { selectedRepository: repoA });
    const base = request({ repository: repoA, selectedLabels: ["bug"] });
    expect(
      reconcileInboxRepository(base, [profile({ repos: [repoA] })], "profile"),
    ).toBe(base);
  });

  it("returns the request untouched when the active profile is not in the list yet", () => {
    const base = request({ repository: repoA });
    expect(
      reconcileInboxRepository(base, [profile({ repos: [repoB] })], "other"),
    ).toBe(base);
  });
});
