// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../../src/renderer/src/app";
import { APP_BOOT_OPERATIONS, APP_BOOT_ROUTES } from "./app-boot-routes";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import { inbox as inboxWithRow } from "./inbox-flow-fixtures";
import { callPath } from "./review-workbench-fixtures";

let installed: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  installed?.restore();
  installed = undefined;
});

const repo = { host: "github.com", owner: "owner", repo: "repo" };
const profile = {
  id: "profile",
  label: "Profile",
  githubHost: "github.com",
  ghAccount: "fixture",
  repos: [repo],
};

function callsTo(double: DesktopDouble, path: string): number {
  return double.request.mock.calls.filter(
    ([request]) => callPath(request) === path,
  ).length;
}

describe("App Pull requests Insight state", () => {
  it("reads each row's Insight state from local records when shown and when a run settles, without another listing", async () => {
    let briefReady = false;
    const double = installDesktopDouble(
      {
        ...APP_BOOT_ROUTES,
        "/v1/profiles": () => success([profile]),
        "/v1/inbox": () =>
          success({
            ...inboxWithRow,
            profile,
            inbox: {
              ...inboxWithRow.inbox,
              state: "open",
              pageSize: 25,
              repositories: [
                {
                  repo: { host: "github.com", owner: "owner", repo: "repo" },
                  state: "ready",
                },
              ],
            },
          }),
        "/v1/inbox/insight-readiness": () =>
          success({
            rows: [
              {
                number: 1,
                ...(briefReady && { insights: { brief: "ready" } }),
              },
            ],
          }),
      },
      { operations: APP_BOOT_OPERATIONS },
    );
    installed = double;
    render(<App />);
    await screen.findByLabelText("Brief: Not run");
    await waitFor(() =>
      expect(callsTo(double, "/v1/inbox/insight-readiness")).toBe(1),
    );
    const listings = callsTo(double, "/v1/inbox");

    briefReady = true;
    act(() => double.sendInsightSettled());

    // Review details and the row's tag read the same field.
    await screen.findByLabelText("Brief: Ready");
    expect(screen.getAllByText("Brief")).toHaveLength(2);
    expect(callsTo(double, "/v1/inbox/insight-readiness")).toBe(2);
    expect(callsTo(double, "/v1/inbox")).toBe(listings);
  });
});
