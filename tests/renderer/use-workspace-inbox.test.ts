// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadInboxViewPreferences,
  saveInboxViewPreferences,
} from "../../src/renderer/src/inbox-view-preferences";
import {
  useWorkspaceInbox,
  type WorkspaceInbox,
} from "../../src/renderer/src/hooks/use-workspace-inbox";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
  localStorage.clear();
});

type RepositoryFixture = {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
};

type ProfileFixture = {
  readonly id: string;
  readonly label: string;
  readonly githubHost: string;
  readonly ghAccount: string;
  readonly repos: ReadonlyArray<RepositoryFixture>;
};

const repositoryA: RepositoryFixture = {
  host: "github.com",
  owner: "owner-a",
  repo: "repo-a",
};
const repositoryB: RepositoryFixture = {
  host: "github.com",
  owner: "owner-b",
  repo: "repo-b",
};
const profileA: ProfileFixture = {
  id: "a",
  label: "Profile A",
  githubHost: "github.com",
  ghAccount: "a",
  repos: [repositoryA],
};
const profileB: ProfileFixture = {
  id: "b",
  label: "Profile B",
  githubHost: "github.com",
  ghAccount: "b",
  repos: [repositoryA, repositoryB],
};
const profileEmpty: ProfileFixture = {
  ...profileB,
  repos: [],
};

function inbox(profile: ProfileFixture) {
  return {
    profile,
    inbox: {
      state: "open",
      pageSize: 25,
      rows: [],
      repositories: [],
      dataFreshness: "fresh",
    },
  };
}

function deferredResponse() {
  let resolve: (value: ReturnType<typeof success>) => void = () => undefined;
  return {
    promise: new Promise<ReturnType<typeof success>>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

function targetRequest(repository: RepositoryFixture): string {
  return `/v1/inbox?state=open&pageSize=25&host=${repository.host}&owner=${repository.owner}&repo=${repository.repo}`;
}

/** The four More filters, each cleared by an explicitly stored `undefined`. */
const MORE_FILTER_KEYS = [
  "reviewState",
  "checkStatus",
  "author",
  "baseBranch",
] as const;

/**
 * What the saved preferences must hold after one More-filters change. A key
 * that is absent or `undefined` must not be present in the stored record at
 * all, so a cleared filter cannot come back on the next load.
 */
type ExpectedStoredFilters = {
  readonly reviewState?: string | undefined;
  readonly checkStatus?: string | undefined;
  readonly author?: string | undefined;
  readonly baseBranch?: string | undefined;
};

function saveConflictingPreferences(): void {
  saveInboxViewPreferences("a", {
    state: "merged",
    pageSize: 10,
    awaitingMyReview: true,
    selectedLabels: ["from-a"],
    selectedRepository: repositoryA,
  });
  saveInboxViewPreferences("b", {
    state: "merged",
    pageSize: 50,
    awaitingMyReview: true,
    selectedLabels: ["from-b"],
    selectedRepository: repositoryB,
  });
}

describe("useWorkspaceInbox profile-switch bootstrap", () => {
  it("resets target B filters before restoring its saved repository", async () => {
    saveConflictingPreferences();
    const paths: string[] = [];
    desktop = installDesktopDouble({
      "/v1/profiles": () => success([profileA, profileB]),
      "/v1/logs": () => success({}),
      "/v1/inbox": (input) => {
        paths.push(input.path);
        return success(inbox(profileB));
      },
    });
    const { result } = renderHook(() =>
      useWorkspaceInbox({ fixtureMode: true, initialState: undefined }),
    );
    act(() => {
      result.current.resetInboxStateOnProfileLoad.current = true;
    });

    await act(async () => {
      await result.current.loadWorkspace();
    });
    await waitFor(() => expect(result.current.inboxListPending).toBe(false));

    expect(paths).toEqual([
      "/v1/inbox?state=open&pageSize=25",
      targetRequest(repositoryB),
    ]);
    expect(result.current.inboxRequest).toMatchObject({
      repository: repositoryB,
      state: "open",
      pageSize: 25,
      selectedLabels: [],
      awaitingMyReview: false,
    });
    expect(loadInboxViewPreferences("b").selectedLabels).toEqual([]);
  });

  it("falls back to the first target repository when its saved choice is invalid", async () => {
    saveInboxViewPreferences("b", {
      selectedRepository: { ...repositoryB, repo: "removed" },
      selectedLabels: ["stale-for-removed-repository"],
    });
    const paths: string[] = [];
    desktop = installDesktopDouble({
      "/v1/profiles": () => success([profileA, profileB]),
      "/v1/logs": () => success({}),
      "/v1/inbox": (input) => {
        paths.push(input.path);
        return success(inbox(profileB));
      },
    });
    const { result } = renderHook(() =>
      useWorkspaceInbox({ fixtureMode: true, initialState: undefined }),
    );
    act(() => {
      result.current.resetInboxStateOnProfileLoad.current = true;
    });

    await act(async () => {
      await result.current.loadWorkspace();
    });
    await waitFor(() => expect(result.current.inboxListPending).toBe(false));

    expect(paths).toEqual([
      "/v1/inbox?state=open&pageSize=25",
      targetRequest(repositoryA),
    ]);
    expect(result.current.inboxRequest.repository).toEqual(repositoryA);
    expect(loadInboxViewPreferences("b")).toMatchObject({
      selectedRepository: repositoryA,
      selectedLabels: [],
    });
  });

  it("keeps an empty target watchlist unscoped", async () => {
    const paths: string[] = [];
    desktop = installDesktopDouble({
      "/v1/profiles": () => success([profileA, profileEmpty]),
      "/v1/logs": () => success({}),
      "/v1/inbox": (input) => {
        paths.push(input.path);
        return success(inbox(profileEmpty));
      },
    });
    const { result } = renderHook(() =>
      useWorkspaceInbox({ fixtureMode: true, initialState: undefined }),
    );
    act(() => {
      result.current.resetInboxStateOnProfileLoad.current = true;
    });

    await act(async () => {
      await result.current.loadWorkspace();
    });

    expect(paths).toEqual(["/v1/inbox?state=open&pageSize=25"]);
    expect(result.current.inboxRequest.repository).toBeUndefined();
    expect(result.current.inboxListPending).toBe(false);
  });

  it("does not let an overtaken A response alter settled B rows or request state", async () => {
    saveConflictingPreferences();
    const firstInbox = deferredResponse();
    let profileCalls = 0;
    const paths: string[] = [];
    desktop = installDesktopDouble({
      "/v1/profiles": () => {
        profileCalls += 1;
        return success(profileCalls === 1 ? [profileA] : [profileA, profileB]);
      },
      "/v1/logs": () => success({}),
      "/v1/inbox": (input) => {
        paths.push(input.path);
        return paths.length === 1
          ? firstInbox.promise
          : success(inbox(profileB));
      },
    });
    const { result } = renderHook(() =>
      useWorkspaceInbox({ fixtureMode: true, initialState: undefined }),
    );

    let loadA: Promise<void> | undefined;
    let loadB: Promise<void> | undefined;
    act(() => {
      loadA = result.current.loadWorkspace();
    });
    await waitFor(() =>
      expect(paths).toEqual([
        "/v1/inbox?state=merged&pageSize=10&label=from-a&awaitingMyReview=1",
      ]),
    );
    act(() => {
      result.current.resetInboxStateOnProfileLoad.current = true;
      loadB = result.current.loadWorkspace();
    });
    await act(async () => {
      await loadB;
    });
    await waitFor(() => expect(result.current.inboxListPending).toBe(false));
    await act(async () => {
      firstInbox.resolve(success(inbox(profileA)));
      await loadA;
    });

    expect(paths).toEqual([
      "/v1/inbox?state=merged&pageSize=10&label=from-a&awaitingMyReview=1",
      "/v1/inbox?state=open&pageSize=25",
      targetRequest(repositoryB),
    ]);
    expect(result.current.dashboard?.profile.id).toBe("b");
    expect(result.current.inbox?.profile.id).toBe("b");
    expect(result.current.inboxRequest).toMatchObject({
      repository: repositoryB,
      state: "open",
      pageSize: 25,
      selectedLabels: [],
      awaitingMyReview: false,
    });
    expect(result.current.inboxListPending).toBe(false);
  });

  it.each([
    {
      name: "selecting review state",
      apply: (workspace: WorkspaceInbox) =>
        workspace.changeInboxReviewState("approved"),
      initialFilter: {
        checkStatus: "pending" as const,
      },
      requestFilter: {
        reviewState: "approved" as const,
        checkStatus: "pending" as const,
      },
      preference: { reviewState: "approved" as const },
      query: "reviewState=approved&checkStatus=pending",
    },
    {
      name: "clearing review state",
      apply: (workspace: WorkspaceInbox) =>
        workspace.changeInboxReviewState(undefined),
      initialFilter: {
        reviewState: "approved" as const,
        checkStatus: "pending" as const,
      },
      requestFilter: { checkStatus: "pending" as const },
      preference: { reviewState: undefined },
      query: "checkStatus=pending",
    },
    {
      name: "selecting check status",
      apply: (workspace: WorkspaceInbox) =>
        workspace.changeInboxCheckStatus("failure"),
      initialFilter: {
        reviewState: "approved" as const,
      },
      requestFilter: {
        reviewState: "approved" as const,
        checkStatus: "failure" as const,
      },
      preference: { checkStatus: "failure" as const },
      query: "reviewState=approved&checkStatus=failure",
    },
    {
      name: "clearing check status",
      apply: (workspace: WorkspaceInbox) =>
        workspace.changeInboxCheckStatus(undefined),
      initialFilter: {
        reviewState: "approved" as const,
        checkStatus: "failure" as const,
      },
      requestFilter: { reviewState: "approved" as const },
      preference: { checkStatus: undefined },
      query: "reviewState=approved",
    },
    {
      // The renderer only trims and drops a blank value; the length cap and
      // the rejected characters are the route's to enforce.
      name: "typing an author, which is trimmed",
      apply: (workspace: WorkspaceInbox) =>
        workspace.changeInboxAuthor("  octocat  "),
      initialFilter: { baseBranch: "main" as const },
      requestFilter: { author: "octocat", baseBranch: "main" },
      preference: { author: "octocat" as const },
      query: "author=octocat&base=main",
    },
    {
      name: "emptying the author, which clears it",
      apply: (workspace: WorkspaceInbox) => workspace.changeInboxAuthor("   "),
      initialFilter: {
        author: "octocat" as const,
        baseBranch: "main" as const,
      },
      requestFilter: { baseBranch: "main" },
      preference: { author: undefined },
      query: "base=main",
    },
    {
      name: "typing a base branch",
      apply: (workspace: WorkspaceInbox) =>
        workspace.changeInboxBaseBranch("release/2026-09"),
      initialFilter: { author: "octocat" as const },
      requestFilter: { author: "octocat", baseBranch: "release/2026-09" },
      preference: { baseBranch: "release/2026-09" as const },
      query: "author=octocat&base=release%2F2026-09",
    },
    {
      name: "clearing the base branch",
      apply: (workspace: WorkspaceInbox) =>
        workspace.changeInboxBaseBranch(undefined),
      initialFilter: {
        author: "octocat" as const,
        baseBranch: "main" as const,
      },
      requestFilter: { author: "octocat" },
      preference: { baseBranch: undefined },
      query: "author=octocat",
    },
  ])(
    "changes the $name, resets pagination, persists it, and preserves the other filters",
    async ({ apply, initialFilter, requestFilter, preference, query }) => {
      const paths: string[] = [];
      desktop = installDesktopDouble({
        "/v1/profiles": () => success([profileA]),
        "/v1/logs": () => success({}),
        "/v1/inbox": (input) => {
          paths.push(input.path);
          return success(inbox(profileA));
        },
      });
      const { result } = renderHook(() =>
        useWorkspaceInbox({ fixtureMode: true, initialState: undefined }),
      );

      await act(async () => {
        await result.current.loadWorkspace();
      });
      await waitFor(() =>
        expect(result.current.dashboard?.profile.id).toBe("a"),
      );
      act(() => {
        result.current.updateInboxRequest({
          ...result.current.inboxRequest,
          selectedLabels: ["bug"],
          awaitingMyReview: true,
          pageToken: "stale-page",
          previousPageTokens: ["older-page"],
          ...initialFilter,
        });
        apply(result.current);
      });

      expect(result.current.inboxRequest).toMatchObject({
        repository: repositoryA,
        selectedLabels: ["bug"],
        awaitingMyReview: true,
        previousPageTokens: [],
        ...requestFilter,
      });
      expect(result.current.inboxRequest).not.toHaveProperty("pageToken");
      const savedPreferences = loadInboxViewPreferences("a");
      const expectedStored: ExpectedStoredFilters = preference;
      for (const key of MORE_FILTER_KEYS) {
        const expected = expectedStored[key];
        if (expected === undefined)
          expect(savedPreferences).not.toHaveProperty(key);
        else expect(savedPreferences).toHaveProperty(key, expected);
      }
      await waitFor(() =>
        expect(paths.at(-1)).toBe(
          `/v1/inbox?state=open&pageSize=25&host=github.com&owner=owner-a&repo=repo-a&label=bug&awaitingMyReview=1&${query}`,
        ),
      );
    },
  );

  it("refuses an author with a space without saving, sending, or refreshing", async () => {
    const paths: string[] = [];
    saveInboxViewPreferences("a", { author: "octocat" });
    desktop = installDesktopDouble({
      "/v1/profiles": () => success([profileA]),
      "/v1/logs": () => success({}),
      "/v1/inbox": (input) => {
        paths.push(input.path);
        return success(inbox(profileA));
      },
    });
    const { result } = renderHook(() =>
      useWorkspaceInbox({ fixtureMode: true, initialState: undefined }),
    );
    await act(async () => {
      await result.current.loadWorkspace();
    });
    await waitFor(() => expect(result.current.dashboard?.profile.id).toBe("a"));
    await waitFor(() =>
      expect(result.current.inboxRequest.author).toBe("octocat"),
    );
    const pathsBefore = paths.length;

    let refusal: string | undefined;
    act(() => {
      refusal = result.current.changeInboxAuthor("John Smith");
    });

    expect(refusal).toBe("characters");
    expect(result.current.inboxRequest.author).toBe("octocat");
    expect(loadInboxViewPreferences("a").author).toBe("octocat");
    expect(paths).toHaveLength(pathsBefore);
  });

  it("clears all four More filters in one request while preserving other filters", async () => {
    const paths: string[] = [];
    saveInboxViewPreferences("a", {
      reviewState: "approved",
      checkStatus: "failure",
      author: "octocat",
      baseBranch: "main",
    });
    desktop = installDesktopDouble({
      "/v1/profiles": () => success([profileA]),
      "/v1/logs": () => success({}),
      "/v1/inbox": (input) => {
        paths.push(input.path);
        return success(inbox(profileA));
      },
    });
    const { result } = renderHook(() =>
      useWorkspaceInbox({ fixtureMode: true, initialState: undefined }),
    );
    await act(async () => {
      await result.current.loadWorkspace();
    });
    await waitFor(() => expect(result.current.dashboard?.profile.id).toBe("a"));
    act(() => {
      result.current.updateInboxRequest({
        ...result.current.inboxRequest,
        selectedLabels: ["bug"],
        awaitingMyReview: true,
        reviewState: "approved",
        checkStatus: "failure",
        author: "octocat",
        baseBranch: "main",
        pageToken: "stale-page",
        previousPageTokens: ["older-page"],
      });
      result.current.clearInboxMoreFilters();
    });

    expect(result.current.inboxRequest).toMatchObject({
      repository: repositoryA,
      state: "open",
      pageSize: 25,
      selectedLabels: ["bug"],
      awaitingMyReview: true,
      previousPageTokens: [],
    });
    const savedPreferences = loadInboxViewPreferences("a");
    for (const key of MORE_FILTER_KEYS) {
      expect(result.current.inboxRequest).not.toHaveProperty(key);
      expect(savedPreferences).not.toHaveProperty(key);
    }
    await waitFor(() =>
      expect(paths.at(-1)).toBe(
        "/v1/inbox?state=open&pageSize=25&host=github.com&owner=owner-a&repo=repo-a&label=bug&awaitingMyReview=1",
      ),
    );
    expect(paths.filter((path) => path.includes("owner=owner-a"))).toHaveLength(
      2,
    );
  });
});
