// @vitest-environment jsdom

import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import type { AppDestination } from "../../src/renderer/src/routes";
import {
  VisitedPullRequests,
  visitedRowLabels,
} from "../../src/renderer/src/components/visited-pull-requests";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  desktop?.restore();
  desktop = undefined;
  window.localStorage.clear();
});

const OPENED_AT = "2026-09-10T09:58:00.000Z";
const NOW = "2026-09-10T10:00:00.000Z";

const titled = {
  reviewId: "review-titled",
  owner: "kwanpham2195",
  repo: "patchdesk",
  number: 125,
  title: "Prototype: three sidebar variants for #119",
  openedAt: OPENED_AT,
} satisfies RawJsonValue;

const untitled = {
  reviewId: "review-untitled",
  owner: "kwanpham2195",
  repo: "herdr",
  number: 7,
  openedAt: OPENED_AT,
} satisfies RawJsonValue;

// Shares `titled`'s repository, so a column holding the two of them lists one.
const untitledSameRepo = {
  reviewId: "review-untitled-same-repo",
  owner: "kwanpham2195",
  repo: "patchdesk",
  number: 412,
  openedAt: OPENED_AT,
} satisfies RawJsonValue;

function renderColumn(options: {
  readonly rows: ReadonlyArray<RawJsonValue>;
  readonly destination?: AppDestination;
  readonly onNavigate?: (destination: AppDestination) => void;
}): void {
  desktop = installDesktopDouble({
    "/v1/sidebar/reviews": () => success({ rows: options.rows, unreadable: 0 }),
  });
  render(
    <VisitedPullRequests
      profileId="profile-1"
      destination={options.destination ?? { kind: "dashboard" }}
      onNavigate={options.onNavigate ?? (() => undefined)}
      reloadKey={0}
      workspaceLabel="Personal"
    />,
  );
}

describe("VisitedPullRequests", () => {
  it("shows the empty state and lists no row when nothing has been opened", async () => {
    renderColumn({ rows: [] });

    const column = screen.getByRole("complementary", {
      name: "Pull requests you have opened",
    });
    // The empty column explains itself in prose; the wording is the
    // component's to change.
    expect(await within(column).findAllByRole("paragraph")).not.toHaveLength(0);
    expect(within(column).queryAllByRole("button")).toHaveLength(0);
  });

  it("gives the header strip a hover fallback for the workspace and marks the list recent", async () => {
    renderColumn({ rows: [titled] });

    await screen.findByRole("button", { name: /#125/ });
    const column = screen.getByRole("complementary", {
      name: "Pull requests you have opened",
    });
    // The label is the one truncatable string with no other hover fallback.
    const label = within(column).getByTitle("Personal");
    expect(label.textContent).toBe("Personal");
    expect(within(column).getByText("recent").textContent).toBe("recent");
  });

  it("renders the derived label and reference on the row", async () => {
    renderColumn({ rows: [titled] });

    const row = await screen.findByRole("button", { name: /#125/ });
    const labels = visitedRowLabels(titled, false);
    expect(row.textContent).toContain(labels.title);
    expect(row.textContent).toContain(labels.reference);
  });

  it("leaves owner/repo off the rows when they all name one repository", async () => {
    renderColumn({ rows: [titled, untitledSameRepo] });

    const fallback = await screen.findByRole("button", { name: /#412/ });
    expect(fallback.textContent).toContain("#412");
    const column = screen.getByRole("complementary", {
      name: "Pull requests you have opened",
    });
    expect(column.textContent).not.toContain("kwanpham2195/patchdesk");
  });

  it("names owner/repo on the rows when they span two repositories", async () => {
    renderColumn({ rows: [titled, untitled] });

    const row = await screen.findByRole("button", { name: /#125/ });
    expect(row.textContent).toContain("kwanpham2195/patchdesk #125 · ");
    // The titleless row carries the same rule in its fallback label.
    expect(screen.getByRole("button", { name: /#7/ }).textContent).toContain(
      "kwanpham2195/herdr#7",
    );
  });

  it("marks the row of the open pull request as the current page", async () => {
    renderColumn({
      rows: [titled, untitled],
      destination: { kind: "workbench", reviewId: "review-untitled" },
    });

    const open = await screen.findByRole("button", { name: /#7/ });
    expect(open.getAttribute("aria-current")).toBe("page");
    // Focusable but inert, so Enter on it is announced as leading nowhere.
    expect(open.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByRole("button", { name: /#125/ }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("navigates for another row and does nothing for the row already open", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    renderColumn({
      rows: [titled, untitled],
      destination: { kind: "workbench", reviewId: "review-untitled" },
      onNavigate,
    });

    await user.click(await screen.findByRole("button", { name: /#7/ }));
    expect(onNavigate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /#125/ }));
    expect(onNavigate).toHaveBeenCalledWith({
      kind: "workbench",
      reviewId: "review-titled",
    });
  });

  it("stamps the row with the time it was opened and never ticks it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    renderColumn({ rows: [titled] });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const row = screen.getByRole("button", { name: /#125/ });
    // How the age reads is `formatCompactRelativeTime`'s own test; the row
    // only has to carry the stamp and never redraw it (ADR 0032).
    const age = row.querySelector("time");
    expect(age?.dateTime).toBe(OPENED_AT);
    const shown = age?.textContent;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    expect(row.querySelector("time")?.textContent).toBe(shown);
  });
});

describe("visitedRowLabels", () => {
  it("keeps a stored title and prints the reference under it", () => {
    expect(visitedRowLabels(titled, false)).toEqual({
      title: "Prototype: three sidebar variants for #119",
      reference: "#125 · ",
    });
  });

  it("names the repository in the reference when the rows span more than one", () => {
    expect(visitedRowLabels(titled, true)).toEqual({
      title: "Prototype: three sidebar variants for #119",
      reference: "kwanpham2195/patchdesk #125 · ",
    });
  });

  it("falls back to the number alone and drops the reference for a row with no title", () => {
    expect(visitedRowLabels(untitled, false)).toEqual({
      title: "#7",
      reference: "",
    });
  });

  it("falls back to owner/repo#number when the rows span more than one", () => {
    expect(visitedRowLabels(untitled, true)).toEqual({
      title: "kwanpham2195/herdr#7",
      reference: "",
    });
  });
});
