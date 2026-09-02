// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InboxFlow } from "../../src/renderer/src/flows/inbox-flow";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import {
  asJsonBody,
  deferred,
  inbox,
  openErrorAlert,
  openRowTitle,
  pasteText,
  projection,
  renderInboxFlow,
  reviewRequestPaths,
  rowBusy,
  sentRequests,
  SHARED_INBOX_ROUTES,
  watchingDashboard,
} from "./inbox-flow-fixtures";

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
  vi.restoreAllMocks();
});

describe("InboxFlow pasted pull-request link", () => {
  it("opens a pasted link to a watched repository through the row's own opening operation", async () => {
    const open = deferred<ReturnType<typeof success>>();
    desktop = installDesktopDouble({
      ...SHARED_INBOX_ROUTES,
      "/v1/reviews/open": () => open.promise,
    });
    const opened: WorkbenchResponse[] = [];
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        dashboard={watchingDashboard}
        // SAFETY: InboxFlow reads only the fixture fields supplied here.
        inbox={inbox as never}
        state="success"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={vi.fn()}
        onOpenWorkbench={(value) => opened.push(value)}
      />,
    );

    pasteText(document, "https://github.com/owner/repo/pull/1");

    expect(reviewRequestPaths(desktop)).toEqual(["/v1/reviews/open"]);
    expect(
      sentRequests(desktop).find(
        (request) => request.path === "/v1/reviews/open",
      )?.body,
    ).toEqual({
      profileId: "profile",
      host: "github.com",
      owner: "owner",
      repo: "repo",
      number: 1,
    });
    // The pasted link and the listed row name one pull request, so the row
    // shows the opening it started.
    expect(rowBusy(screen.getByRole("option"))).toBe(true);

    open.resolve(success(asJsonBody(projection)));
    await waitFor(() => expect(opened).toHaveLength(1));
  });

  it("refuses a link to a repository outside the watchlist and sends nothing", async () => {
    desktop = installDesktopDouble(SHARED_INBOX_ROUTES);
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        dashboard={watchingDashboard}
        // SAFETY: InboxFlow reads only the fixture fields supplied here.
        inbox={inbox as never}
        state="success"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={vi.fn()}
        onOpenWorkbench={vi.fn()}
      />,
    );

    pasteText(document, "https://github.com/other/elsewhere/pull/9");

    const alert = await waitFor(() => {
      const raised = openErrorAlert();
      if (raised === undefined) throw new Error("Expected a refusal");
      return raised;
    });
    expect(
      within(alert).getByText(
        "Not opened: other/elsewhere is not a watched repository.",
      ),
    ).toBeTruthy();
    expect(reviewRequestPaths(desktop)).toEqual([]);
  });

  it("leaves text that is not a pull-request reference alone", () => {
    desktop = installDesktopDouble(SHARED_INBOX_ROUTES);
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        dashboard={watchingDashboard}
        // SAFETY: InboxFlow reads only the fixture fields supplied here.
        inbox={inbox as never}
        state="success"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={vi.fn()}
        onOpenWorkbench={vi.fn()}
      />,
    );

    pasteText(document, "just some notes about owner/repo");

    expect(reviewRequestPaths(desktop)).toEqual([]);
    expect(openErrorAlert()).toBeUndefined();
  });

  it("ignores a paste into a text field, even a valid link", () => {
    desktop = installDesktopDouble(SHARED_INBOX_ROUTES);
    renderInboxFlow(
      <>
        <InboxFlow
          destination="dashboard"
          dashboard={watchingDashboard}
          // SAFETY: InboxFlow reads only the fixture fields supplied here.
          inbox={inbox as never}
          state="success"
          refreshStatus="Current"
          onRefresh={vi.fn()}
          onSettings={vi.fn()}
          onOpenWorkbench={vi.fn()}
        />
        <input aria-label="Somewhere to type" />
      </>,
    );

    pasteText(
      screen.getByRole("textbox", { name: "Somewhere to type" }),
      "https://github.com/owner/repo/pull/1",
    );

    expect(reviewRequestPaths(desktop)).toEqual([]);
    expect(openErrorAlert()).toBeUndefined();
  });

  it("ignores a paste naming a pull request that is already opening", () => {
    const load = deferred<ReturnType<typeof success>>();
    desktop = installDesktopDouble({
      ...SHARED_INBOX_ROUTES,
      "/v1/reviews/load": () => load.promise,
    });
    renderInboxFlow(
      <InboxFlow
        destination="dashboard"
        dashboard={watchingDashboard}
        // SAFETY: InboxFlow reads only the fixture fields supplied here.
        inbox={inbox as never}
        state="success"
        refreshStatus="Current"
        onRefresh={vi.fn()}
        onSettings={vi.fn()}
        onOpenWorkbench={vi.fn()}
      />,
    );

    openRowTitle();
    pasteText(document, "https://github.com/owner/repo/pull/1");

    expect(reviewRequestPaths(desktop)).toEqual(["/v1/reviews/load"]);
  });
});
