// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parsePullRequestInput } from "../../src/domain/pull-request";
import type { CheckSummary } from "../../src/domain/github-context";
import {
  ReviewChecks,
  presentOverallCheckResult,
} from "../../src/renderer/src/components/review-checks";
import { installDesktopDouble } from "./fake-desktop-response";

let desktop: ReturnType<typeof installDesktopDouble> | undefined;

afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
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

  it("keeps the compact section keyboard-collapsible", async () => {
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

    await user.click(screen.getByRole("button", { name: "Collapse checks" }));
    expect(
      screen.queryByRole("list", { name: "Pull request checks" }),
    ).toBeNull();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("list", { name: "Pull request checks" }),
    ).toBeTruthy();
  });

  // Which label every outcome and freshness maps to is the rule
  // `check-result-presentation.test.ts` owns. What that test cannot see is
  // whether this component still asks the rule, and asks it with both of its
  // inputs — so one row per input compares the rendered aggregate against
  // the rule's own answer rather than against a written-out label.
  it.each([
    ["the aggregate outcome", "failing" as const, undefined],
    ["the freshness override", "passing" as const, "not_refreshed" as const],
  ])(
    "renders %s through the shared label rule",
    (_name, overall, freshness) => {
      const checks: CheckSummary = { overall, checks: [] };
      render(
        <ReviewChecks
          checks={checks}
          {...(freshness === undefined ? {} : { freshness })}
        />,
      );
      expect(
        screen.getByText(presentOverallCheckResult(overall, freshness).label),
      ).toBeTruthy();
    },
  );

  it("opens a same-host check URL through the desktop bridge instead of a native anchor", async () => {
    const user = userEvent.setup();
    const parsed = parsePullRequestInput(
      "https://github.com/centraldigital/patchdesk/pull/42",
    );
    if (parsed._tag === "err")
      throw new Error("Fixture pull request is invalid");
    const openExternalHttps = vi.fn(async () => true);
    desktop = installDesktopDouble({}, { openExternalHttps });

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
