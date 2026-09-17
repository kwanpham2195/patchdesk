// @vitest-environment jsdom
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import { parsePullRequestInput } from "../../src/domain/pull-request";
import { MaintainerInbox } from "../../src/renderer/src/components/maintainer-inbox";
import { ReviewWorkbenchHeader } from "../../src/renderer/src/components/review-workbench-header";
import { WatchPullRequestButton } from "../../src/renderer/src/components/watch-pull-request-button";
import {
  useWatchedPullRequests,
  WatchedPullRequestsProvider,
} from "../../src/renderer/src/hooks/use-watched-pull-requests";
import type { InboxRow } from "../../src/renderer/src/renderer-contracts";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import { projection } from "./review-workbench-fixtures";

let installed: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  installed?.restore();
  installed = undefined;
});

const ref = { host: "github.com", owner: "acme", repo: "widgets", number: 7 };

/** Answers the list with `initial` and every Watch or Unwatch with `answer`. */
function installWatchRoutes(
  initial: RawJsonValue,
  answer: () => ReturnType<typeof success> | ReturnType<typeof failure>,
): DesktopDouble {
  installed = installDesktopDouble({
    "/v1/watched-pull-requests": (input) =>
      input.method === undefined ? success(initial) : answer(),
  });
  return installed;
}

function wrapper({ children }: { readonly children: ReactNode }) {
  return (
    <WatchedPullRequestsProvider profileId="cfw">
      {children}
    </WatchedPullRequestsProvider>
  );
}

describe("useWatchedPullRequests", () => {
  it("watches with the profile and ref, then reads the list the API answers", async () => {
    const double = installWatchRoutes({ pullRequests: [] }, () =>
      success({ pullRequests: [ref] }),
    );
    const { result } = renderHook(() => useWatchedPullRequests(), { wrapper });
    await waitFor(() => expect(result.current).toBeDefined());

    await act(() => result.current?.toggle(ref) ?? Promise.resolve());

    expect(
      double.request.mock.calls.flatMap(([input]) =>
        "path" in input && input.method !== undefined
          ? [[input.method, input.body]]
          : [],
      ),
    ).toEqual([["POST", { profileId: "cfw", pullRequest: ref }]]);
    expect(result.current?.isWatched(ref)).toBe(true);
  });

  it("reports the cap from a refused watch", async () => {
    installWatchRoutes({ pullRequests: [] }, () =>
      failure({ error: { _tag: "WatchLimitReached", limit: 20 } }, 400),
    );
    const { result } = renderHook(() => useWatchedPullRequests(), { wrapper });
    await waitFor(() => expect(result.current).toBeDefined());

    await act(() => result.current?.toggle(ref) ?? Promise.resolve());

    expect(result.current?.failureFor(ref)).toEqual({
      kind: "limit",
      limit: 20,
    });
    expect(result.current?.isWatched(ref)).toBe(false);
  });

  it("unwatches a watched pull request", async () => {
    const double = installWatchRoutes({ pullRequests: [ref] }, () =>
      success({ pullRequests: [] }),
    );
    const { result } = renderHook(() => useWatchedPullRequests(), { wrapper });
    await waitFor(() => expect(result.current?.isWatched(ref)).toBe(true));

    await act(() => result.current?.toggle(ref) ?? Promise.resolve());

    expect(
      double.request.mock.calls.some(
        ([input]) => "path" in input && input.method === "DELETE",
      ),
    ).toBe(true);
    expect(result.current?.isWatched(ref)).toBe(false);
  });
});

const row: InboxRow = {
  remoteState: "open",
  identity: ref,
  title: "PR",
  author: "author",
  baseBranch: "main",
  headBranch: "change",
  currentHeadSha: "a".repeat(40),
  isDraft: false,
  updatedAt: "2026-08-13T00:00:00.000Z",
  changeStats: {},
  checks: { overall: "unknown", checks: [] },
  reviewState: "none",
  mergeability: "unknown",
  labels: [],
  categories: [],
  recommendedAction: { kind: "run_review" },
  dataFreshness: "fresh",
};

describe("watched pull request change", () => {
  it("lights the freshness badge until a refresh newer than the change", async () => {
    const double = installWatchRoutes({ pullRequests: [ref] }, () =>
      success({ pullRequests: [ref] }),
    );
    const inbox = (refreshedAt: string) => (
      <WatchedPullRequestsProvider profileId="cfw">
        <MaintainerInbox
          profileId="watch-badge"
          profileLabel="P"
          rows={[row]}
          freshness="fresh"
          refreshStatus="Current"
          snapshot={{ state: "current", refreshedAt }}
          onOpenReview={vi.fn()}
          onOpenReviewId={vi.fn()}
        />
      </WatchedPullRequestsProvider>
    );
    const view = render(inbox("2026-01-01T00:00:00.000Z"));
    await screen.findAllByRole("button", { name: "Unwatch" });

    act(() => double.sendWatchedPullRequestChange("other-profile"));
    expect(
      screen.queryByRole("button", { name: /A watched pull request changed/ }),
    ).toBeNull();
    act(() => double.sendWatchedPullRequestChange("cfw"));
    expect(
      screen.getByRole("button", { name: /A watched pull request changed/ }),
    ).toBeTruthy();

    view.rerender(inbox(new Date(Date.now() + 60_000).toISOString()));
    expect(
      screen.queryByRole("button", { name: /A watched pull request changed/ }),
    ).toBeNull();
  });
});

describe("watched pull request unwatched by a poll", () => {
  it("re-reads the watched list on a change, so a merged pull request shows Watch again", async () => {
    let list: RawJsonValue = { pullRequests: [ref] };
    const double = installDesktopDouble({
      "/v1/watched-pull-requests": () => success(list),
    });
    installed = double;
    render(
      <WatchedPullRequestsProvider profileId="cfw">
        <WatchPullRequestButton pullRequest={ref} />
      </WatchedPullRequestsProvider>,
    );
    await screen.findByRole("button", { name: "Unwatch" });

    list = { pullRequests: [] };
    act(() => double.sendWatchedPullRequestChange("cfw"));

    expect(await screen.findByRole("button", { name: "Watch" })).toBeTruthy();
  });
});

describe("Watch toggle surfaces", () => {
  it("watches from the Pull requests inspector and marks the row", async () => {
    installWatchRoutes({ pullRequests: [] }, () =>
      success({ pullRequests: [ref] }),
    );
    render(
      <WatchedPullRequestsProvider profileId="cfw">
        <MaintainerInbox
          profileId="watch-inspector"
          profileLabel="P"
          rows={[row]}
          freshness="fresh"
          refreshStatus="Current"
          onOpenReview={vi.fn()}
          onOpenReviewId={vi.fn()}
        />
      </WatchedPullRequestsProvider>,
    );

    const [watch] = await screen.findAllByRole("button", { name: "Watch" });
    if (watch === undefined) throw new Error("no Watch button");
    fireEvent.click(watch);

    expect(
      (await screen.findAllByRole("button", { name: "Unwatch" })).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("option", { name: /Watched/ })).toBeTruthy();
  });

  it("offers Watch in the Review header for an open pull request", async () => {
    installWatchRoutes({ pullRequests: [] }, () =>
      success({ pullRequests: [ref] }),
    );
    const model = projection();
    const parsed = parsePullRequestInput("acme/widgets#7");
    if (parsed._tag === "err") throw new Error("invalid fixture");
    render(
      <WatchedPullRequestsProvider profileId="cfw">
        <ReviewWorkbenchHeader
          model={model}
          actions={{
            detectUpdates: vi.fn(),
            refresh: vi.fn(),
            loadCommitDiff: vi.fn(),
            reportNavigationState: vi.fn(),
          }}
          title="Canonical workbench"
          repository="centraldigital/patchdesk"
          checksLabel="Passing"
          freshnessLabel="Current"
          mergeStatus="Ready"
          hasUpdates={false}
          terminal={false}
          externalPullRequest={parsed.value}
          openOverview={vi.fn()}
          setSummaryDialogOpen={vi.fn()}
        />
      </WatchedPullRequestsProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Watch" }));

    expect(await screen.findByRole("button", { name: "Unwatch" })).toBeTruthy();
  });
});
