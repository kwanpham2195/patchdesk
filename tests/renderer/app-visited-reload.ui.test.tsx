// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../../src/renderer/src/app";
import { APP_BOOT_OPERATIONS, APP_BOOT_ROUTES } from "./app-boot-routes";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import { inbox as inboxWithRow, openErrorAlert } from "./inbox-flow-fixtures";
import { callPath } from "./review-workbench-fixtures";

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
const visitedRow = {
  reviewId: "review-7",
  owner: "acme",
  repo: "gadgets",
  number: 7,
  title: "Visited pull request",
  sortedAt: "2026-09-10T10:00:00.000Z",
};

function requestsTo(double: DesktopDouble, path: string): number {
  return double.request.mock.calls.filter(
    ([request]) => callPath(request)?.split("?")[0] === path,
  ).length;
}

function installApp(routes: Parameters<typeof installDesktopDouble>[0]) {
  installed = installDesktopDouble(
    {
      ...APP_BOOT_ROUTES,
      "/v1/profiles": () => success([profile]),
      "/v1/inbox": () =>
        success({
          ...inboxWithRow,
          inbox: { ...inboxWithRow.inbox, state: "open", pageSize: 25 },
        }),
      "/v1/sidebar/reviews": () =>
        success({ rows: [visitedRow], unreadable: 0 }),
      ...routes,
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
  return installed;
}

describe("App Visited column after a failed open", () => {
  it.each([
    ["the record is missing", failure({ error: "not_found" }, 404)],
    ["the load fails", failure({ error: "unavailable" }, 500)],
  ])(
    "returns to Pull requests with the error and keeps the row clickable when %s",
    async (_case, response) => {
      const user = userEvent.setup();
      const double = installApp({ "/v1/reviews/load": () => response });

      await user.click(
        await screen.findByRole("button", { name: /Visited pull request/ }),
      );

      await waitFor(() => expect(openErrorAlert()).toBeDefined());
      expect(openErrorAlert()?.textContent).toContain(
        "Could not open the saved review.",
      );
      expect(window.localStorage.getItem("patchdesk.destination")).toBe(
        "dashboard",
      );
      const row = screen.getByRole("button", {
        name: /Visited pull request/,
      });
      expect(row.getAttribute("aria-disabled")).toBeNull();

      await user.click(row);
      await waitFor(() =>
        expect(requestsTo(double, "/v1/reviews/load")).toBe(2),
      );
    },
  );
});

describe("App Visited column after Clear local review data", () => {
  it("reads the column again once the cleanup finishes", async () => {
    const user = userEvent.setup();
    const double = installApp({
      "/v1/storage/usage": () =>
        success({ cacheBytes: 0, localReviewDataBytes: 0, logsBytes: 0 }),
      "/v1/storage/clear-local-data": () => success({}),
    });
    await screen.findByRole("button", { name: /Visited pull request/ });
    const readsBefore = requestsTo(double, "/v1/sidebar/reviews");

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      await screen.findByRole("tab", { name: "Data & recovery" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Clear local review data" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Clear local data" }),
    );

    await waitFor(() =>
      expect(requestsTo(double, "/v1/storage/clear-local-data")).toBe(1),
    );
    await waitFor(() =>
      expect(requestsTo(double, "/v1/sidebar/reviews")).toBeGreaterThan(
        readsBefore,
      ),
    );
  });
});
