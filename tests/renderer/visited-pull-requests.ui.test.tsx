// @vitest-environment jsdom

import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import type { AppDestination } from "../../src/renderer/src/routes";
import {
  VisitedPullRequests,
  visitedDateGroupLabel,
  visitedRowLabels,
  visitedTerminalMarker,
} from "../../src/renderer/src/components/visited-pull-requests";
import { formatExactTime } from "../../src/renderer/src/lib/relative-time";
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
// Midday, so a whole number of days either side of it stays on the same local
// calendar day in every timezone the tests may run in.
const MIDDAY = Date.parse("2026-09-10T12:00:00.000Z");
const DAY_MS = 86_400_000;

/** A row whose only interesting field is which date bucket it lands in. */
function aged(number: number, daysAgo: number): RawJsonValue {
  return {
    reviewId: `review-${number}`,
    owner: "kwanpham2195",
    repo: "patchdesk",
    number,
    title: `Opened ${daysAgo} days ago`,
    openedAt: new Date(MIDDAY - daysAgo * DAY_MS).toISOString(),
  };
}

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

// The only fixture under another owner, so a column holding it and `titled`
// spans two owners as well as two repositories.
const otherOwner = {
  reviewId: "review-other-owner",
  owner: "centraldigital",
  repo: "cfw-sales-crm-api",
  number: 98,
  openedAt: OPENED_AT,
} satisfies RawJsonValue;

const MERGED_OBSERVED_AT = new Date(MIDDAY - 3 * DAY_MS).toISOString();

// The pull request reached its end state, and the row must say when that was
// seen rather than implying it was just read from GitHub.
const merged = {
  reviewId: "review-merged",
  owner: "kwanpham2195",
  repo: "patchdesk",
  number: 300,
  title: "Land the visited column",
  openedAt: OPENED_AT,
  terminal: { state: "merged", observedAt: MERGED_OBSERVED_AT },
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
    const labels = visitedRowLabels(titled, "number");
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

  it("names the repository without the owner when the rows share one owner", async () => {
    renderColumn({ rows: [titled, untitled] });

    const row = await screen.findByRole("button", { name: /#125/ });
    expect(row.textContent).toContain("patchdesk #125 · ");
    // The titleless row carries the same rule in its fallback label.
    expect(screen.getByRole("button", { name: /#7/ }).textContent).toContain(
      "herdr#7",
    );
    const column = screen.getByRole("complementary", {
      name: "Pull requests you have opened",
    });
    // The owner distinguishes nothing here, so it costs width for nothing.
    expect(column.textContent).not.toContain("kwanpham2195");
  });

  it("names owner/repo on the rows when they span two owners", async () => {
    renderColumn({ rows: [titled, otherOwner] });

    const row = await screen.findByRole("button", { name: /#125/ });
    expect(row.textContent).toContain("kwanpham2195/patchdesk #125 · ");
    // The titleless row carries the same rule in its fallback label.
    expect(screen.getByRole("button", { name: /#98/ }).textContent).toContain(
      "centraldigital/cfw-sales-crm-api#98",
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

  it("dates the state a terminal row reached and leaves an open row unmarked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MIDDAY);
    renderColumn({ rows: [merged, titled] });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const marked = screen.getByRole("button", { name: /#300/ });
    expect(marked.textContent).toContain("Merged · seen 3d");
    // The exact instant sits on hover, the way the row's own age does.
    expect(
      within(marked).getByTitle(formatExactTime(MERGED_OBSERVED_AT))
        .textContent,
    ).toBe("Merged · seen 3d");
    // An open pull request gets no marker at all; absence is the design.
    const open = screen.getByRole("button", { name: /#125/ });
    expect(open.textContent).not.toContain("seen");
  });

  it("heads each date bucket the rows reach, in the order the route returned them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MIDDAY);
    renderColumn({ rows: [aged(1, 0), aged(2, 1), aged(3, 4), aged(4, 30)] });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const column = screen.getByRole("complementary", {
      name: "Pull requests you have opened",
    });
    expect(headings(column)).toEqual([
      "Today",
      "Yesterday",
      "This week",
      "Earlier",
    ]);
    // Headers are inserted between the rows; the order the route sent stands.
    expect(
      within(column)
        .getAllByRole("button")
        .map((row) => row.getAttribute("title")),
    ).toEqual([
      "Opened 0 days ago",
      "Opened 1 days ago",
      "Opened 4 days ago",
      "Opened 30 days ago",
    ]);
  });

  it("names no bucket that holds no row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MIDDAY);
    renderColumn({ rows: [aged(1, 0), aged(2, 30)] });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const column = screen.getByRole("complementary", {
      name: "Pull requests you have opened",
    });
    expect(headings(column)).toEqual(["Today", "Earlier"]);
  });
});

/** The date headers standing in the column, top to bottom. */
function headings(column: HTMLElement): ReadonlyArray<string> {
  return within(column)
    .getAllByRole("paragraph")
    .map((paragraph) => paragraph.textContent ?? "")
    .filter((text) =>
      ["Today", "Yesterday", "This week", "Earlier"].includes(text),
    );
}

describe("visitedDateGroupLabel", () => {
  it("keeps every row opened on the current calendar day under Today", () => {
    expect(visitedDateGroupLabel(iso(0), MIDDAY)).toBe("Today");
    // A clock that ran ahead of the stored stamp still reads as the day it is.
    expect(visitedDateGroupLabel(iso(-1), MIDDAY)).toBe("Today");
  });

  it("names the day before, and stops naming it at two", () => {
    expect(visitedDateGroupLabel(iso(1), MIDDAY)).toBe("Yesterday");
    expect(visitedDateGroupLabel(iso(2), MIDDAY)).toBe("This week");
  });

  it("holds the week open to the sixth day back and cuts at the seventh", () => {
    expect(visitedDateGroupLabel(iso(4), MIDDAY)).toBe("This week");
    expect(visitedDateGroupLabel(iso(6), MIDDAY)).toBe("This week");
    expect(visitedDateGroupLabel(iso(7), MIDDAY)).toBe("Earlier");
  });

  it("puts a month-old row, and a stamp it cannot read, in Earlier", () => {
    expect(visitedDateGroupLabel(iso(30), MIDDAY)).toBe("Earlier");
    expect(visitedDateGroupLabel("not a timestamp", MIDDAY)).toBe("Earlier");
  });
});

function iso(daysAgo: number): string {
  return new Date(MIDDAY - daysAgo * DAY_MS).toISOString();
}

describe("visitedTerminalMarker", () => {
  it("dates a merged pull request with when Patchdesk saw it, in the info tone", () => {
    expect(
      visitedTerminalMarker({ state: "merged", observedAt: iso(3) }, MIDDAY),
    ).toEqual({ label: "Merged · seen 3d", tone: "text-status-info" });
  });

  it("dates a closed pull request the same way, in the destructive tone", () => {
    expect(
      visitedTerminalMarker({ state: "closed", observedAt: iso(12) }, MIDDAY),
    ).toEqual({ label: "Closed · seen 12d", tone: "text-destructive" });
  });
});

describe("visitedRowLabels", () => {
  it("keeps a stored title and prints the reference under it", () => {
    expect(visitedRowLabels(titled, "number")).toEqual({
      title: "Prototype: three sidebar variants for #119",
      reference: "#125 · ",
    });
  });

  it("names the repository alone in the reference under one owner", () => {
    expect(visitedRowLabels(titled, "repo")).toEqual({
      title: "Prototype: three sidebar variants for #119",
      reference: "patchdesk #125 · ",
    });
  });

  it("names the owner in the reference when the rows span two owners", () => {
    expect(visitedRowLabels(titled, "owner-repo")).toEqual({
      title: "Prototype: three sidebar variants for #119",
      reference: "kwanpham2195/patchdesk #125 · ",
    });
  });

  it("falls back to the number alone and drops the reference for a row with no title", () => {
    expect(visitedRowLabels(untitled, "number")).toEqual({
      title: "#7",
      reference: "",
    });
  });

  it("falls back to repo#number under one owner", () => {
    expect(visitedRowLabels(untitled, "repo")).toEqual({
      title: "herdr#7",
      reference: "",
    });
  });

  it("falls back to owner/repo#number when the rows span two owners", () => {
    expect(visitedRowLabels(untitled, "owner-repo")).toEqual({
      title: "kwanpham2195/herdr#7",
      reference: "",
    });
  });
});
