// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  composeInboxSearchQuery,
  INBOX_SEARCH_QUERY_MAX_LENGTH,
} from "../../src/domain/maintainer-inbox";
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
    preset: "awaiting_my_review",
    selectedLabels: ["from-a"],
    selectedRepository: repositoryA,
  });
  saveInboxViewPreferences("b", {
    state: "merged",
    pageSize: 50,
    preset: "awaiting_my_review",
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
        "/v1/inbox?state=merged&pageSize=10&label=from-a&preset=awaiting_my_review",
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
      "/v1/inbox?state=merged&pageSize=10&label=from-a&preset=awaiting_my_review",
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
          preset: "awaiting_my_review",
          pageToken: "stale-page",
          previousPageTokens: ["older-page"],
          ...initialFilter,
        });
        apply(result.current);
      });

      expect(result.current.inboxRequest).toMatchObject({
        repository: repositoryA,
        selectedLabels: ["bug"],
        preset: "awaiting_my_review",
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
          `/v1/inbox?state=open&pageSize=25&host=github.com&owner=owner-a&repo=repo-a&label=bug&preset=awaiting_my_review&${query}`,
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

  it("refuses a label selection whose query would pass GitHub's cap", async () => {
    // Each label is within the per-label cap; four of them against this
    // repository are not, and nothing downstream could tell that refusal
    // apart from a network failure.
    const longLabels = [1, 2, 3, 4].map((index) =>
      `${index}`.padEnd(50, "-label-name"),
    );
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
    await waitFor(() => expect(result.current.dashboard?.profile.id).toBe("a"));
    act(() => {
      result.current.updateInboxRequest({
        ...result.current.inboxRequest,
        selectedLabels: longLabels.slice(0, 3),
      });
    });
    const pathsBefore = paths.length;

    expect(
      result.current.inboxFilterBudget.labelFits(longLabels[3] ?? ""),
    ).toBe(false);
    act(() => {
      result.current.changeInboxLabels(longLabels);
    });

    expect(result.current.inboxRequest.selectedLabels).toEqual(
      longLabels.slice(0, 3),
    );
    expect(loadInboxViewPreferences("a").selectedLabels).toEqual([]);
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
        preset: "awaiting_my_review",
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
      preset: "awaiting_my_review",
      previousPageTokens: [],
    });
    const savedPreferences = loadInboxViewPreferences("a");
    for (const key of MORE_FILTER_KEYS) {
      expect(result.current.inboxRequest).not.toHaveProperty(key);
      expect(savedPreferences).not.toHaveProperty(key);
    }
    await waitFor(() =>
      expect(paths.at(-1)).toBe(
        "/v1/inbox?state=open&pageSize=25&host=github.com&owner=owner-a&repo=repo-a&label=bug&preset=awaiting_my_review",
      ),
    );
    expect(paths.filter((path) => path.includes("owner=owner-a"))).toHaveLength(
      2,
    );
  });

  describe("search length limit for every filter", () => {
    /** Two labels that put the repository-A query one character under GitHub's cap, so any filter that adds a qualifier, or a longer state, breaches it. */
    function labelsOneUnderTheCap(): ReadonlyArray<string> {
      const base = composeInboxSearchQuery([repositoryA], {
        state: "open",
        labels: ["", ""],
      }).length;
      const room = INBOX_SEARCH_QUERY_MAX_LENGTH - 1 - base;
      return [
        "a".repeat(Math.floor(room / 2)),
        "b".repeat(Math.ceil(room / 2)),
      ];
    }

    async function nearLimitHook(paths: string[]) {
      desktop = installDesktopDouble({
        "/v1/profiles": () => success([profileA]),
        "/v1/logs": () => success({}),
        "/v1/inbox": (input) => {
          paths.push(input.path);
          return success(inbox(profileA));
        },
      });
      const hook = renderHook(() =>
        useWorkspaceInbox({ fixtureMode: true, initialState: undefined }),
      );
      await act(async () => {
        await hook.result.current.loadWorkspace();
      });
      await waitFor(() =>
        expect(hook.result.current.dashboard?.profile.id).toBe("a"),
      );
      const labels = labelsOneUnderTheCap();
      act(() => {
        hook.result.current.updateInboxRequest({
          ...hook.result.current.inboxRequest,
          selectedLabels: labels,
        });
      });
      return hook;
    }

    it("reports State, Preset, Review state, and Check status as not fitting, and sends nothing when called anyway", async () => {
      const paths: string[] = [];
      const { result } = await nearLimitHook(paths);
      const pathsBefore = paths.length;
      const before = result.current.inboxRequest;

      expect(result.current.inboxFilterBudget.fits({ state: "merged" })).toBe(
        false,
      );
      expect(
        result.current.inboxFilterBudget.fits({ preset: "awaiting_my_review" }),
      ).toBe(false);
      expect(
        result.current.inboxFilterBudget.fits({ reviewState: "approved" }),
      ).toBe(false);
      expect(
        result.current.inboxFilterBudget.fits({ checkStatus: "success" }),
      ).toBe(false);
      // Clearing or keeping a value never lengthens the query.
      expect(result.current.inboxFilterBudget.fits({ state: "open" })).toBe(
        true,
      );
      expect(result.current.inboxFilterBudget.fits({ preset: undefined })).toBe(
        true,
      );

      act(() => {
        result.current.changeInboxState("merged");
        result.current.changeInboxPreset("my_pull_requests");
        result.current.changeInboxReviewState("approved");
        result.current.changeInboxCheckStatus("success");
      });

      expect(result.current.inboxRequest).toEqual(before);
      expect(loadInboxViewPreferences("a").state).toBe("open");
      expect(loadInboxViewPreferences("a")).not.toHaveProperty("preset");
      expect(loadInboxViewPreferences("a")).not.toHaveProperty("reviewState");
      expect(loadInboxViewPreferences("a")).not.toHaveProperty("checkStatus");
      expect(paths).toHaveLength(pathsBefore);
    });

    const longRepository: RepositoryFixture = {
      host: "github.com",
      owner: "o".repeat(39),
      repo: "r".repeat(100),
    };

    async function repositorySwitch(
      overrides: Partial<WorkspaceInbox["inboxRequest"]>,
    ) {
      const paths: string[] = [];
      const hook = await nearLimitHook(paths);
      act(() => {
        hook.result.current.updateInboxRequest({
          ...hook.result.current.inboxRequest,
          selectedLabels: [],
          ...overrides,
        });
      });
      act(() => {
        hook.result.current.changeInboxRepository(longRepository);
      });
      return { ...hook, paths };
    }

    // The longest repository name GitHub allows: it leaves room for Base branch, or for Author, but not both.
    it("drops Author first on a repository switch, then stops once the query fits", async () => {
      const { result, paths } = await repositorySwitch({
        author: "a".repeat(39),
        baseBranch: "b".repeat(40),
        reviewState: "approved",
      });

      expect(result.current.inboxRequest.repository).toEqual(longRepository);
      expect(result.current.inboxRequest.author).toBeUndefined();
      expect(result.current.inboxRequest.baseBranch).toBe("b".repeat(40));
      expect(result.current.inboxRequest.reviewState).toBe("approved");
      expect(result.current.inboxFilterBudget.dropped).toEqual(["Author"]);
      expect(loadInboxViewPreferences("a")).not.toHaveProperty("author");
      await waitFor(() =>
        expect(paths.at(-1)).toContain(`owner=${longRepository.owner}`),
      );
    });

    it("drops Author, then Base branch, and keeps the rest once the query fits", async () => {
      const { result } = await repositorySwitch({
        author: "a".repeat(39),
        baseBranch: "b".repeat(100),
        preset: "my_pull_requests",
        reviewState: "approved",
        checkStatus: "success",
      });

      expect(result.current.inboxFilterBudget.dropped).toEqual([
        "Author",
        "Base branch",
      ]);
      expect(result.current.inboxRequest).toMatchObject({
        preset: "my_pull_requests",
        reviewState: "approved",
        checkStatus: "success",
      });
      expect(result.current.inboxRequest.baseBranch).toBeUndefined();
      expect(result.current.inboxRequest.repository).toEqual(longRepository);
    });
  });
});
