// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../../src/renderer/src/app";
import { APP_BOOT_OPERATIONS, APP_BOOT_ROUTES } from "./app-boot-routes";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import { asJsonBody, inbox as inboxWithRow } from "./inbox-flow-fixtures";
import { callPath, projection } from "./review-workbench-fixtures";

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
  repos: [{ host: "github.com", owner: "acme", repo: "widgets" }],
};

function openRequests(double: DesktopDouble): number {
  return double.request.mock.calls.filter(
    ([request]) => callPath(request) === "/v1/reviews/open",
  ).length;
}

describe("App leave guard for an unsaved Review draft (#606)", () => {
  it("opens Navigate over a kept draft and holds a chosen pull request behind the leave dialog", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("patchdesk.destination", "workbench:review-42");
    const double = installDesktopDouble(
      {
        ...APP_BOOT_ROUTES,
        "/v1/profiles": () => success([profile]),
        "/v1/inbox": () =>
          success({
            ...inboxWithRow,
            profile,
            inbox: { ...inboxWithRow.inbox, state: "open", pageSize: 25 },
          }),
        "/v1/reviews/leave": () => success(null),
        "/v1/reviews/load": () => success(asJsonBody(projection())),
        "/v1/reviews/open": () =>
          success(
            asJsonBody(
              projection({ review: { id: "review-43", status: "open" } }),
            ),
          ),
      },
      { operations: APP_BOOT_OPERATIONS },
    );
    installed = double;
    render(
      <App
        reviewWorkbenchLoader={async () => ({
          default: (props) => (
            <button
              type="button"
              onClick={() => props.onNavigationStateChange("dirty_draft")}
            >
              Keep a summary on {props.workbench.review.id}
            </button>
          ),
        })}
      />,
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Keep a summary on review-42",
      }),
    );
    const chooseAnotherPullRequest = async (): Promise<void> => {
      await user.keyboard("{Meta>}k{/Meta}");
      await user.type(
        await screen.findByRole("combobox", {
          name: "Search views and actions",
        }),
        "acme/widgets#43",
      );
      await user.click(
        screen.getByRole("option", { name: "Open acme/widgets#43" }),
      );
    };

    await chooseAnotherPullRequest();
    await user.click(
      await screen.findByRole("button", { name: "Stay on this review" }),
    );
    expect(
      screen.getByRole("button", { name: "Keep a summary on review-42" }),
    ).toBeTruthy();
    expect(openRequests(double)).toBe(0);

    await chooseAnotherPullRequest();
    expect(openRequests(double)).toBe(0);
    await user.click(
      await screen.findByRole("button", { name: "Discard changes and leave" }),
    );

    await screen.findByRole("button", { name: "Keep a summary on review-43" });
    await waitFor(() => expect(openRequests(double)).toBe(1));
  });
});
