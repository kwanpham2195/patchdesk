// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parsePullRequestInput } from "../../src/domain/pull-request";
import type { CheckSummary } from "../../src/domain/github-context";
import { ReviewChecks } from "../../src/renderer/src/components/review-checks";

afterEach(() => {
  cleanup();
  delete (window as unknown as { patchdesk?: unknown }).patchdesk;
});

describe("review checks", () => {
  it("groups duplicates, keeps failures first, and collapses a long passing list", async () => {
    const user = userEvent.setup();
    render(
      <ReviewChecks
        checks={{
          overall: "failing",
          checks: [
            {
              name: "lint",
              required: true,
              status: "completed",
              conclusion: "failure",
            },
            {
              name: "coverage",
              required: "unknown",
              status: "completed",
              conclusion: "success",
            },
            {
              name: "coverage",
              required: "unknown",
              status: "completed",
              conclusion: "success",
            },
            {
              name: "api",
              required: false,
              status: "completed",
              conclusion: "success",
            },
            {
              name: "build",
              required: false,
              status: "completed",
              conclusion: "success",
            },
            {
              name: "unit",
              required: false,
              status: "completed",
              conclusion: "success",
            },
            {
              name: "e2e",
              required: false,
              status: "completed",
              conclusion: "success",
            },
            {
              name: "package",
              required: false,
              status: "completed",
              conclusion: "success",
            },
          ],
        }}
        freshness="fresh"
      />,
    );

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("lint");
    expect(
      screen.getByRole("button", { name: "Show 6 passing checks" }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Show 6 passing checks" }),
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    expect(screen.getByText("×2")).toBeTruthy();
    expect(screen.getAllByText("Passed")).toHaveLength(6);
  });

  it("keeps the compact section keyboard-collapsible and hides noisy requirement text", async () => {
    const user = userEvent.setup();
    render(
      <ReviewChecks
        checks={{
          overall: "passing",
          checks: [
            {
              name: "Sonar",
              required: "unknown",
              status: "completed",
              conclusion: "success",
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByText("No requirement metadata", { selector: ".sr-only" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Collapse checks" }));
    expect(
      screen.queryByRole("list", { name: "Pull request checks" }),
    ).toBeNull();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("list", { name: "Pull request checks" }),
    ).toBeTruthy();
  });

  it("maps every aggregate outcome through the shared label rule", () => {
    const cases: ReadonlyArray<[CheckSummary["overall"], string]> = [
      ["passing", "Passing"],
      ["failing", "Failing"],
      ["pending", "In progress"],
      ["skipped", "Skipped"],
      ["unknown", "Unknown"],
    ];
    for (const [overall, label] of cases) {
      cleanup();
      render(<ReviewChecks checks={{ overall, checks: [] }} />);
      expect(screen.getByText(label)).toBeTruthy();
    }
    cleanup();
    render(
      <ReviewChecks
        checks={{ overall: "passing", checks: [] }}
        freshness="not_refreshed"
      />,
    );
    expect(screen.getByText("Not refreshed")).toBeTruthy();
    cleanup();
    render(
      <ReviewChecks
        checks={{ overall: "passing", checks: [] }}
        freshness="unavailable"
      />,
    );
    expect(screen.getByText("Unavailable")).toBeTruthy();
  });

  it("opens a same-host check URL through the desktop bridge instead of a native anchor", async () => {
    const user = userEvent.setup();
    const parsed = parsePullRequestInput(
      "https://github.com/centraldigital/patchdesk/pull/42",
    );
    if (parsed._tag === "err")
      throw new Error("Fixture pull request is invalid");
    const openExternalHttps = vi.fn(async () => true);
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: { openExternalHttps },
    });

    render(
      <ReviewChecks
        pullRequest={parsed.value}
        checks={{
          overall: "passing",
          checks: [
            {
              name: "unit",
              required: true,
              status: "completed",
              conclusion: "success",
              url: "/centraldigital/patchdesk/actions/runs/1",
            },
          ],
        }}
      />,
    );

    expect(screen.queryByRole("link")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Open unit in GitHub" }),
    );
    expect(openExternalHttps).toHaveBeenCalledWith(
      "https://github.com/centraldigital/patchdesk/actions/runs/1",
    );
  });
});
