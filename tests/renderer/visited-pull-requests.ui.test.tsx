// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import type { AppDestination } from "../../src/renderer/src/routes";
import { VisitedPullRequests } from "../../src/renderer/src/components/visited-pull-requests";
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

function renderColumn(options: {
  readonly rows: ReadonlyArray<RawJsonValue>;
  readonly destination?: AppDestination;
  readonly watchedRepoCount?: number;
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
      watchedRepoCount={options.watchedRepoCount ?? 1}
    />,
  );
}

describe("VisitedPullRequests", () => {
  it("explains the empty column in two lines and lists no row", async () => {
    renderColumn({ rows: [] });

    expect(
      await screen.findByText(/have not opened a pull request/),
    ).toBeTruthy();
    expect(screen.getByText(/Open one from Pull requests/)).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("names the repository on each row only when the workspace watches more than one", async () => {
    renderColumn({ rows: [titled], watchedRepoCount: 1 });

    await screen.findByRole("button", { name: /#125/ });
    expect(
      screen.queryByRole("button", { name: /kwanpham2195\/patchdesk #125/ }),
    ).toBeNull();

    cleanup();
    desktop?.restore();
    renderColumn({ rows: [titled], watchedRepoCount: 2 });

    expect(
      await screen.findByRole("button", {
        name: /kwanpham2195\/patchdesk #125/,
      }),
    ).toBeTruthy();
  });

  it("falls back to owner/repo#number when the record has no title", async () => {
    renderColumn({ rows: [untitled] });

    expect(
      await screen.findByRole("button", { name: /kwanpham2195\/herdr#7/ }),
    ).toBeTruthy();
  });

  it("marks the row of the open pull request as the current page", async () => {
    renderColumn({
      rows: [titled, untitled],
      destination: { kind: "workbench", reviewId: "review-untitled" },
    });

    const open = await screen.findByRole("button", { name: /#7/ });
    expect(open.getAttribute("aria-current")).toBe("page");
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

  it("keeps the relative age fixed as time passes, so no clock ticks the column", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    renderColumn({ rows: [titled] });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("button", { name: /2 min ago/ })).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    expect(screen.getByRole("button", { name: /2 min ago/ })).toBeTruthy();
  });
});
