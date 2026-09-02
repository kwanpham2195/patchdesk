import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

import { BusyProvider } from "../../src/renderer/src/hooks/use-busy";
import { BusyIndicator } from "../../src/renderer/src/components/busy-indicator";
import type { RawJsonValue } from "../../src/domain/json";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import type { Dashboard } from "../../src/renderer/src/renderer-models";
import {
  success,
  type DesktopDouble,
  type DesktopRoute,
} from "./fake-desktop-response";

const sha = "a".repeat(40);
const patchHash = "b".repeat(64);

export const savedRow = {
  remoteState: "open" as const,
  identity: { host: "github.com", owner: "owner", repo: "repo", number: 1 },
  title: "PR",
  author: "author",
  baseBranch: "main",
  headBranch: "change",
  currentHeadSha: sha,
  isDraft: false,
  updatedAt: "2026-08-13T00:00:00.000Z",
  changeStats: {},
  checks: { overall: "unknown", checks: [] },
  reviewState: "none",
  mergeability: "unknown",
  labels: [],
  latestReview: {
    reviewId: "review-1",
    reviewedHeadSha: sha,
    updatedAt: "2026-08-13T00:00:00.000Z",
    matchesCurrentHead: true,
  },
  categories: ["updated_since_review"],
  recommendedAction: {
    kind: "open_saved_review",
    reviewId: "review-1",
  },
  dataFreshness: "fresh",
};

export const dashboard: Dashboard = {
  profile: {
    id: "profile",
    label: "Profile",
    githubHost: "github.com",
    ghAccount: "fixture",
  },
  dashboard: { repos: [] },
};

/** The same profile with a watchlist, which only the paste path reads. */
export const watchingDashboard: Dashboard = {
  ...dashboard,
  profile: {
    ...dashboard.profile,
    repos: [{ host: "github.com", owner: "owner", repo: "repo" }],
  },
};

export const inbox = {
  profile: {
    id: "profile",
    label: "Profile",
    githubHost: "github.com",
    ghAccount: "fixture",
  },
  inbox: {
    rows: [savedRow],
    repositories: [],
    dataFreshness: "fresh",
  },
};

export const projection: WorkbenchResponse = {
  state: "review",
  viewerLogin: "fixture",
  review: { id: "review-1", status: "open" },
  session: {
    id: "session-1",
    key: {
      profileId: "profile",
      host: "github.com",
      owner: "owner",
      repo: "repo",
      prNumber: 1,
      headSha: sha,
    },
  },
  revision: {
    reviewedHeadSha: sha,
    currentHeadSha: sha,
    freshness: "fresh",
    refreshedAt: "2026-08-01T00:00:00.000Z",
    // SAFETY: test fixture narrows a plain hex string to the branded
    // PatchHash type; only WorkbenchResponse's own parser enforces the brand.
    patchHash: patchHash as never,
  },
  fullPatch:
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  pullRequest: {
    ref: { host: "github.com", owner: "owner", repo: "repo", number: 1 },
    title: "PR",
    author: "author",
    headBranch: "change",
    baseBranch: "main",
    headSha: sha,
    isOpen: true,
    isDraft: false,
    reviewState: "none",
    mergeability: "mergeable",
    labels: [],
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  commits: [],
  insights: {
    analysis: { status: "not_generated" },
    walkthrough: { status: "not_generated" },
  },
  conversation: { prDescription: "", entries: [] },
  checks: { overall: "passing", checks: [] },
  mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
  mergeReasons: [],
};

/**
 * The paths every InboxFlow test answers the same way. Each is a real request
 * the flow makes on mount; naming them here keeps the double strict about the
 * ones a given test is actually about.
 */
export const SHARED_INBOX_ROUTES = {
  "/v1/logs": () => success(null),
  "/v1/github/access": () => success({}),
  "/v1/environment": () => success({}),
} satisfies Readonly<Record<string, DesktopRoute>>;

export function renderInboxFlow(ui: ReactNode): ReturnType<typeof render> {
  return render(
    <BusyProvider>
      {ui}
      <BusyIndicator />
    </BusyProvider>,
  );
}

export type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

export function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolve === undefined) throw new Error("Deferred is not ready");
      resolve(value);
    },
  };
}

/**
 * Every loopback request the flow sent, in order, with its body.
 */
export function sentRequests(
  double: DesktopDouble,
): ReadonlyArray<{ readonly path: string; readonly body?: unknown }> {
  return double.request.mock.calls.flatMap(([input]) =>
    "path" in input ? [input] : [],
  );
}

/**
 * The review endpoints a test drove, in order. Scoped to `/v1/reviews/` on
 * purpose: the renderer also flushes `/v1/logs` through the same bridge, and
 * whether it lands mid-test depends on timing, so asserting over every captured
 * request made these cases order-dependent and intermittently red.
 */
export function reviewRequestPaths(
  double: DesktopDouble,
): ReadonlyArray<string> {
  return sentRequests(double)
    .map((request) => request.path)
    .filter((path) => path.startsWith("/v1/reviews/"));
}

/**
 * Projects a fixture into the JSON grammar `DesktopResponse.body` carries.
 * `WorkbenchResponse` declares optional members the JSON grammar has no way
 * to express.
 */
export function asJsonBody(value: WorkbenchResponse): RawJsonValue {
  // SAFETY: this fixture contains only JSON-compatible data, so its cloned
  // form satisfies the raw bridge-body grammar.
  return structuredClone(value) as RawJsonValue;
}

/** The destructive alert InboxFlow raises when opening a review fails. */
export function openErrorAlert(): HTMLElement | undefined {
  return screen
    .queryAllByRole("alert")
    .find(
      (alert) => within(alert).queryByText("Could not open review") !== null,
    );
}

/**
 * A row click only selects; the title inside it is what opens the Review. The
 * title is styled text with no role, so it is found by the slot it carries.
 */
export function openRowTitle(
  option: HTMLElement = screen.getByRole("option"),
): void {
  const title = option.querySelector('[data-slot="pull-request-title"]');
  if (!(title instanceof HTMLElement))
    throw new Error("expected a pull request title in the row");
  fireEvent.click(title);
}

/** Rows carry `aria-disabled` while opening; they are not `<button>` elements. */
export function rowBusy(option: HTMLElement): boolean {
  return option.getAttribute("aria-disabled") === "true";
}

/** Pastes `text` at `target` the way a real clipboard paste arrives. */
export function pasteText(target: Node, text: string): void {
  fireEvent.paste(target, {
    clipboardData: { getData: () => text },
  });
}
