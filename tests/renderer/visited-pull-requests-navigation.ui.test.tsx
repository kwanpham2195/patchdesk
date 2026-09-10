// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { parseContentHash } from "../../src/domain/ids";
import { App } from "../../src/renderer/src/app";
import type { ReviewWorkbenchFlowProps } from "../../src/renderer/src/flows/review-workbench-flow";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import type { RawJsonValue } from "../../src/domain/json";
import type { LocalApiDesktopRequest } from "../../src/main/ipc-contract";
import { APP_BOOT_OPERATIONS, APP_BOOT_ROUTES } from "./app-boot-routes";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

const sha = "a".repeat(40);
const patchHash = contentHash("b".repeat(64));

let installed: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  installed?.restore();
  installed = undefined;
});

describe("visited pull requests navigation", () => {
  it("loads the second Review when the workbench for another one was on screen", async () => {
    // The workbench route replaces InboxFlow, so leaving one workbench for
    // another mounts InboxFlow again with the workspace already loaded — the
    // one path where the stored-review loader starts from a fresh mount.
    window.localStorage.setItem("patchdesk.destination", "workbench:review-42");
    installDesktop();
    render(
      <StrictMode>
        <App reviewWorkbenchLoader={async () => ({ default: WorkbenchStub })} />
      </StrictMode>,
    );

    expect(await screen.findByText("Open: Pull request 42")).not.toBeNull();
    fireEvent.click(screen.getByTitle("Pull request 113"));

    expect(await screen.findByText("Open: Pull request 113")).not.toBeNull();
  });
});

function WorkbenchStub(props: ReviewWorkbenchFlowProps): React.JSX.Element {
  return <p>Open: {props.workbench.pullRequest?.title ?? "no pull request"}</p>;
}

function installDesktop(): DesktopDouble {
  installed = installDesktopDouble(
    {
      ...APP_BOOT_ROUTES,
      "/v1/sidebar/reviews": () =>
        success({
          rows: [visitedRow("review-113", 113), visitedRow("review-42", 42)],
          unreadable: 0,
        }),
      "/v1/profiles": () => success([profileFixture]),
      "/v1/reviews/load": (input) =>
        success(asJsonBody(projection(requestedReviewId(input)))),
      "/v1/inbox": () => success(inboxFixture),
    },
    { operations: APP_BOOT_OPERATIONS },
  );
  return installed;
}

/** The `reviewId` the renderer asked `POST /v1/reviews/load` for. */
function requestedReviewId(input: LocalApiDesktopRequest): string {
  const body = input.body;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows the raw request body the bridge carries as `unknown`; this fixture is the boundary and no earlier parser exists for it.
  if (body === null || typeof body !== "object" || !("reviewId" in body))
    throw new Error("Expected a reviewId in the load request");
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- same boundary, narrowing the one primitive this route answers on.
  if (typeof body.reviewId !== "string")
    throw new Error("Expected a reviewId in the load request");
  return body.reviewId;
}

function visitedRow(reviewId: string, number: number) {
  return {
    reviewId,
    owner: "centraldigital",
    repo: "patchdesk",
    number,
    title: `Pull request ${number}`,
    openedAt: "2026-08-01T00:00:00.000Z",
  };
}

const profileFixture = {
  id: "profile",
  label: "Profile",
  githubHost: "github.com",
  ghAccount: "fixture",
  repos: [{ host: "github.com", owner: "centraldigital", repo: "patchdesk" }],
};

const inboxFixture = {
  profile: profileFixture,
  inbox: {
    state: "open",
    pageSize: 25,
    rows: [],
    repositories: [],
    dataFreshness: "fresh",
  },
};

function projection(reviewId: string): WorkbenchResponse {
  const number = reviewId === "review-42" ? 42 : 113;
  return {
    state: "review",
    viewerLogin: "fixture",
    review: { id: reviewId, status: "open" },
    session: {
      id: `session-${number}`,
      key: {
        profileId: "profile",
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        prNumber: number,
        headSha: sha,
      },
    },
    revision: {
      reviewedHeadSha: sha,
      currentHeadSha: sha,
      freshness: "fresh",
      refreshedAt: "2026-08-01T00:00:00.000Z",
      patchHash,
    },
    fullPatch:
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    pullRequest: {
      ref: {
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number,
      },
      title: `Pull request ${number}`,
      author: "fixture",
      headBranch: "feature",
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
  } satisfies WorkbenchResponse;
}

/**
 * Projects a fixture into the JSON grammar `DesktopResponse.body` carries.
 * `WorkbenchResponse` declares optional members the JSON grammar has no way
 * to express.
 */
function asJsonBody(value: WorkbenchResponse): RawJsonValue {
  // SAFETY: this fixture contains only JSON-compatible data, so its cloned
  // form satisfies the raw bridge-body grammar.
  return structuredClone(value) as RawJsonValue;
}

function contentHash(value: string) {
  const parsed = parseContentHash(value);
  if (parsed._tag === "err") throw new Error("Expected a content hash fixture");
  return parsed.value;
}
