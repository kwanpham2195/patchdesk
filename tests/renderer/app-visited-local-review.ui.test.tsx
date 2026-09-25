// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import { App } from "../../src/renderer/src/app";
import { APP_BOOT_OPERATIONS, APP_BOOT_ROUTES } from "./app-boot-routes";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
  type DesktopRoute,
} from "./fake-desktop-response";
import { asJsonBody } from "./inbox-flow-fixtures";
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
};
const repository = { host: "github.com", owner: "acme", repo: "widgets" };

/** Boots `App` on the Pull requests screen with one local row in the column. */
function renderWithLocalRow(
  source: RawJsonValue,
  openLocal: DesktopRoute,
): DesktopDouble {
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
        success({
          rows: [
            {
              reviewId: "review-local",
              ...repository,
              source,
              sortedAt: "2026-08-01T00:00:00.000Z",
            },
          ],
          unreadable: 0,
        }),
      "/v1/reviews/open-local": openLocal,
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

/** The one `open-local` request the column sent. */
function openLocalRequest(
  double: DesktopDouble,
): Parameters<DesktopDouble["request"]>[0] | undefined {
  return double.request.mock.calls.find(
    ([request]) => callPath(request) === "/v1/reviews/open-local",
  )?.[0];
}

describe("App visited local Review", () => {
  it("reopens a local sidebar row through the local open route", async () => {
    const user = userEvent.setup();
    const source = { kind: "branch", branch: "feat/x", baseBranch: "main" };
    const double = renderWithLocalRow(source, () =>
      success(asJsonBody(projection())),
    );

    await user.click(
      await screen.findByRole("button", {
        name: /Branch feat\/x against main/,
      }),
    );

    await screen.findByRole("heading", { name: "Review destination" });
    expect(openLocalRequest(double)).toMatchObject({
      body: { profileId: "profile", ...repository, source },
    });
  });

  it("names both branches beside a working-tree row refused after a branch switch, and stays put", async () => {
    const user = userEvent.setup();
    const double = renderWithLocalRow(
      { kind: "working_tree", branch: "feat/449" },
      () => failure({ error: "branch_mismatch", currentBranch: "main" }, 409),
    );
    const column = await screen.findByRole("complementary", {
      name: "Pull requests you have opened",
    });

    await user.click(
      await within(column).findByRole("button", {
        name: /Working tree on feat\/449/,
      }),
    );

    const refusal = await within(column).findByRole("alert");
    expect(refusal.textContent).toContain("main");
    expect(refusal.textContent).toContain("feat/449");
    expect(openLocalRequest(double)).toMatchObject({
      body: {
        source: {
          kind: "working_tree",
          expectedHead: { kind: "branch", branch: "feat/449" },
        },
      },
    });
    // The refusal opens nothing and raises no Pull requests screen notice.
    expect(
      screen.queryByRole("heading", { name: "Review destination" }),
    ).toBeNull();
    expect(screen.queryByText("Could not open review")).toBeNull();
  });
});
