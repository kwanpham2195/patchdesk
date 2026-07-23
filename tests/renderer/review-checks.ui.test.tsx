// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { ReviewChecks } from "../../src/renderer/src/components/review-checks";

afterEach(cleanup);

describe("review checks", () => {
  it("groups duplicates, keeps failures first, and collapses a long passing list", async () => {
    const user = userEvent.setup();
    render(
      <ReviewChecks
        checks={{
          overall: "failing",
          checks: [
            { name: "lint", required: true, status: "completed", conclusion: "failure" },
            { name: "coverage", required: "unknown", status: "completed", conclusion: "success" },
            { name: "coverage", required: "unknown", status: "completed", conclusion: "success" },
            { name: "api", required: false, status: "completed", conclusion: "success" },
            { name: "build", required: false, status: "completed", conclusion: "success" },
            { name: "unit", required: false, status: "completed", conclusion: "success" },
            { name: "e2e", required: false, status: "completed", conclusion: "success" },
            { name: "package", required: false, status: "completed", conclusion: "success" },
          ],
        }}
        freshness="fresh"
      />,
    );

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("lint");
    expect(screen.getByRole("button", { name: "Show 6 passing checks" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show 6 passing checks" }));
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
          checks: [{ name: "Sonar", required: "unknown", status: "completed", conclusion: "success" }],
        }}
      />,
    );

    expect(screen.getByText("No requirement metadata", { selector: ".sr-only" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Collapse checks" }));
    expect(screen.queryByRole("list", { name: "Pull request checks" })).toBeNull();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("list", { name: "Pull request checks" })).toBeTruthy();
  });
});
