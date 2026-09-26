// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../../src/renderer/src/app";
import { APP_BOOT_OPERATIONS, APP_BOOT_ROUTES } from "./app-boot-routes";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import {
  asJsonBody,
  inbox as inboxWithRow,
  openErrorAlert,
} from "./inbox-flow-fixtures";
import { callBody, callPath, projection } from "./review-workbench-fixtures";

let installed: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  installed?.restore();
  installed = undefined;
});

const profile = {
  id: "profile",
  label: "Profile",
  githubHost: "github.com",
  ghAccount: "fixture",
};
const repository = { host: "github.com", owner: "acme", repo: "widgets" };

// One repository's local row (#479), standing for its working-tree Reviews on two branches.
const localRow = {
  ...repository,
  reviewIds: ["review-local-main", "review-local-feat"],
  sortedAt: "2026-08-01T00:00:00.000Z",
};

/** A Review the open-local route answers with, as a local Review of `feat`. */
const openedLocal = projection({
  review: { id: "review-local-feat", status: "open" },
});

/** The one `open-local` request the column sent. */
function openLocalRequest(
  double: DesktopDouble,
): Parameters<DesktopDouble["request"]>[0] | undefined {
  return double.request.mock.calls.find(
    ([request]) => callPath(request) === "/v1/reviews/open-local",
  )?.[0];
}

describe("App visited local Review", () => {
  it("opens the working tree of the checkout's current branch from a repository's local row", async () => {
    const user = userEvent.setup();
    installed = installDesktopDouble(
      {
        ...APP_BOOT_ROUTES,
        "/v1/profiles": () => success([profile]),
        "/v1/inbox": () =>
          success({
            profile,
            inbox: {
              state: "open",
              pageSize: 25,
              rows: [],
              repositories: [],
              dataFreshness: "fresh",
            },
          }),
        "/v1/sidebar/reviews": () =>
          success({ rows: [localRow], unreadable: 0 }),
        "/v1/reviews/open-local": () => success(asJsonBody(openedLocal)),
      },
      { operations: APP_BOOT_OPERATIONS },
    );
    render(
      <App
        reviewWorkbenchLoader={async () => ({
          default: () => <h1>Review destination</h1>,
        })}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: /acme\/widgets/ }),
    );

    await screen.findByRole("heading", { name: "Review destination" });
    const request = openLocalRequest(installed);
    expect(request).toMatchObject({
      body: { profileId: "profile", ...repository },
    });
    // No expected branch: the open follows whatever branch the checkout is on.
    expect(callBody(request)).toMatchObject({
      source: { kind: "working_tree" },
    });
    expect(JSON.stringify(callBody(request)).includes("expectedHead")).toBe(
      false,
    );
    expect(window.localStorage.getItem("patchdesk.destination")).toBe(
      "workbench:review-local-feat",
    );
  });

  it("opens the current working tree once the maintainer leaves a draft for a parked local row click", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("patchdesk.destination", "workbench:review-42");
    installed = installDesktopDouble(
      {
        ...APP_BOOT_ROUTES,
        "/v1/profiles": () => success([profile]),
        // A listed row puts the inbox chrome, and its notices, on screen.
        "/v1/inbox": () =>
          success({
            ...inboxWithRow,
            inbox: { ...inboxWithRow.inbox, state: "open", pageSize: 25 },
          }),
        "/v1/sidebar/reviews": () =>
          success({ rows: [localRow], unreadable: 0 }),
        "/v1/reviews/leave": () => success(null),
        "/v1/reviews/load": () => success(asJsonBody(projection())),
        "/v1/reviews/open-local": () => success(asJsonBody(openedLocal)),
      },
      { operations: APP_BOOT_OPERATIONS },
    );
    render(
      <App
        reviewWorkbenchLoader={async () => ({
          default: (props) => (
            <button
              type="button"
              onClick={() => props.onNavigationStateChange("dirty_draft")}
            >
              Hold a draft on {props.workbench.review.id}
            </button>
          ),
        })}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Hold a draft on review-42" }),
    );
    await user.click(
      await screen.findByRole("button", { name: /acme\/widgets/ }),
    );
    expect(openLocalRequest(installed)).toBeUndefined();
    await user.click(
      await screen.findByRole("button", { name: "Discard changes and leave" }),
    );

    await screen.findByRole("button", {
      name: "Hold a draft on review-local-feat",
    });
    expect(callBody(openLocalRequest(installed))).toMatchObject({
      source: { kind: "working_tree" },
    });
    expect(openErrorAlert()).toBeUndefined();
  });
});
