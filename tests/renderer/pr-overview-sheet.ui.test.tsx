// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CanonicalReviewOverviewSheet,
  mergeReadinessLabel,
  mergeReadinessTone,
  type CanonicalReviewOverview,
} from "../../src/renderer/src/components/pr-overview-sheet";
import type { MergeDisplayReason } from "../../src/domain/github-context";
import { parsePullRequestInput } from "../../src/domain/pull-request";

afterEach(cleanup);

type Readiness = CanonicalReviewOverview["mergeReadiness"];

function fixturePullRequest(): NonNullable<
  CanonicalReviewOverview["pullRequest"]
> {
  const parsed = parsePullRequestInput(
    "https://github.com/centraldigital/patchdesk/pull/42",
  );
  if (parsed._tag === "err") throw new Error("Fixture pull request is invalid");
  return parsed.value;
}

function baseOverview(
  overrides: Partial<CanonicalReviewOverview> = {},
): CanonicalReviewOverview {
  return {
    repository: "centraldigital/patchdesk",
    prNumber: 42,
    title: "Protect review writes",
    summary: "",
    checks: { overall: "passing", checks: [] },
    mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
    mergeReasons: [],
    insights: {
      analysis: { status: "not_generated" },
      walkthrough: { status: "not_generated" },
    },
    ...overrides,
  };
}

function reason(overrides: Partial<MergeDisplayReason>): MergeDisplayReason {
  return {
    code: "checks",
    message: "Required checks have not passed.",
    source: "checks",
    availability: "available",
    openOnGitHub: false,
    ...overrides,
  };
}

function renderOverview(overview: CanonicalReviewOverview): void {
  render(
    <CanonicalReviewOverviewSheet
      open
      onOpenChange={() => undefined}
      overview={overview}
    />,
  );
}

const findingsWarning: Readiness = {
  _tag: "NeedsAcknowledgement",
  blockers: [],
  warnings: [
    {
      code: "findings_need_acknowledgement",
      findingIds: ["finding-1", "finding-2"],
    },
  ],
};

// The sheet only hands the ids over once it has closed, so the harness
// must actually close it the way the workbench does.
function ClosableOverview({
  onReviewFindings,
}: {
  readonly onReviewFindings: (findingIds: ReadonlyArray<string>) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <CanonicalReviewOverviewSheet
      open={open}
      onOpenChange={setOpen}
      overview={baseOverview({ mergeReadiness: findingsWarning })}
      onReviewFindings={onReviewFindings}
    />
  );
}

describe("pr overview sheet merge readiness", () => {
  it("renders a partial reason with the info treatment, not destructive", () => {
    renderOverview(
      baseOverview({
        mergeReadiness: { _tag: "Blocked", blockers: [], warnings: [] },
        mergeReasons: [
          reason({
            code: "review_required",
            message: "Approval required by GitHub.",
            source: "github_pr_state",
            availability: "partial",
            openOnGitHub: true,
          }),
        ],
      }),
    );
    const card = document.querySelector('[data-reason-availability="partial"]');
    expect(card).not.toBeNull();
    expect(card?.className).toContain("border-status-info/30");
    expect(card?.className).not.toContain("border-destructive/30");
    expect(card?.querySelector("svg.lucide-info")).not.toBeNull();
    expect(card?.querySelector("svg.lucide-circle-x")).toBeNull();
  });

  it("renders an available reason with the destructive treatment", () => {
    renderOverview(
      baseOverview({
        mergeReadiness: { _tag: "Blocked", blockers: [], warnings: [] },
        mergeReasons: [
          reason({
            code: "checks",
            message: "Required checks have not passed.",
            source: "checks",
            availability: "available",
          }),
        ],
      }),
    );
    const card = document.querySelector(
      '[data-reason-availability="available"]',
    );
    expect(card).not.toBeNull();
    expect(card?.className).toContain("border-destructive/30");
    expect(card?.className).not.toContain("border-status-info/30");
    expect(card?.querySelector("svg.lucide-circle-x")).not.toBeNull();
  });

  it("renders the mergeability_unknown blocker with the info treatment", () => {
    const readiness: Readiness = {
      _tag: "Blocked",
      blockers: ["mergeability_unknown"],
      warnings: [],
    };
    renderOverview(baseOverview({ mergeReadiness: readiness }));
    const unknownCard = document.querySelector(
      '[data-blocker="mergeability_unknown"]',
    );
    expect(unknownCard).not.toBeNull();
    expect(unknownCard?.className).toContain("border-status-info/30");
    expect(unknownCard?.className).not.toContain("border-destructive/30");
    expect(unknownCard?.querySelector("svg.lucide-info")).not.toBeNull();
  });

  it("still renders a conflicting blocker with the destructive treatment", () => {
    const readiness: Readiness = {
      _tag: "Blocked",
      blockers: ["conflicting"],
      warnings: [],
    };
    renderOverview(baseOverview({ mergeReadiness: readiness }));
    const conflictingCard = document.querySelector(
      '[data-blocker="conflicting"]',
    );
    expect(conflictingCard).not.toBeNull();
    expect(conflictingCard?.className).toContain("border-destructive/30");
    expect(conflictingCard?.className).not.toContain("border-status-info/30");
    expect(
      conflictingCard?.querySelector("svg.lucide-circle-x"),
    ).not.toBeNull();
  });

  it("does not leak the raw availability enum value into rendered text", () => {
    renderOverview(
      baseOverview({
        mergeReadiness: { _tag: "Blocked", blockers: [], warnings: [] },
        mergeReasons: [
          reason({
            code: "review_required",
            message: "Approval required by GitHub.",
            source: "github_pr_state",
            availability: "partial",
            openOnGitHub: true,
          }),
        ],
      }),
    );
    expect(document.body.textContent).not.toContain("partial");
  });

  it("renders multiple merge reasons at once", () => {
    renderOverview(
      baseOverview({
        mergeReadiness: { _tag: "Blocked", blockers: [], warnings: [] },
        mergeReasons: [
          reason({
            code: "review_required",
            message: "Approval required by GitHub.",
            source: "github_pr_state",
            availability: "partial",
            openOnGitHub: true,
          }),
          reason({
            code: "checks",
            message: "Required checks have not passed.",
            source: "checks",
            availability: "available",
            openOnGitHub: false,
          }),
        ],
      }),
    );
    expect(screen.getByText("Approval required by GitHub.")).toBeTruthy();
    expect(screen.getByText("Required checks have not passed.")).toBeTruthy();
    expect(document.querySelectorAll("[data-reason-availability]").length).toBe(
      2,
    );
  });

  // What the header says and how it is toned is the rule
  // `merge-readiness-header.test.ts` owns, for all five readiness states.
  // The one thing that test cannot see is whether this sheet still asks the
  // rule, so this smoke test compares the rendered header against the rule's
  // own answer rather than against a written-out label or class token.
  it.each([
    ["an unconfirmed block", ["mergeability_unknown"]],
    ["a block GitHub confirmed", ["mergeability_unknown", "conflicting"]],
  ] satisfies ReadonlyArray<[string, string[]]>)(
    "renders %s through the shared merge-readiness rule",
    (_name, blockers) => {
      const readiness: Readiness = { _tag: "Blocked", blockers, warnings: [] };
      renderOverview(baseOverview({ mergeReadiness: readiness }));
      const header = screen.getByText(
        mergeReadinessLabel(readiness._tag, blockers),
      );
      expect(header.className).toContain(
        mergeReadinessTone(readiness._tag, blockers),
      );
    },
  );

  it("renders one findings card whose name carries the count", () => {
    renderOverview(baseOverview({ mergeReadiness: findingsWarning }));
    expect(
      screen.getAllByRole("group", {
        name: /need(s)? acknowledgement before merge/,
      }),
    ).toHaveLength(1);
    expect(
      screen.getByRole("group", {
        name: "2 findings need acknowledgement before merge",
      }),
    ).toBeTruthy();
    // No Review findings action without a workbench to land on.
    expect(
      screen.queryByRole("button", { name: "Review findings" }),
    ).toBeNull();
  });

  it("names a single finding in the singular", () => {
    renderOverview(
      baseOverview({
        mergeReadiness: {
          ...findingsWarning,
          warnings: [
            { code: "findings_need_acknowledgement", findingIds: ["only"] },
          ],
        },
      }),
    );
    expect(
      screen.getByRole("group", {
        name: "1 finding needs acknowledgement before merge",
      }),
    ).toBeTruthy();
  });

  it("closes the sheet on Review findings, then calls back with the counted ids", async () => {
    const onReviewFindings = vi.fn();
    render(<ClosableOverview onReviewFindings={onReviewFindings} />);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Review findings" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "PR overview" })).toBeNull(),
    );
    expect(onReviewFindings).toHaveBeenCalledTimes(1);
    expect(onReviewFindings).toHaveBeenCalledWith(["finding-1", "finding-2"]);
  });

  it("lands focus on the Merge readiness row when asked to", async () => {
    render(
      <CanonicalReviewOverviewSheet
        open
        onOpenChange={() => undefined}
        overview={baseOverview({ mergeReadiness: findingsWarning })}
        focusSection="merge_readiness"
      />,
    );
    const row = screen.getByRole("button", { name: "Merge readiness" });
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(row.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows Open on GitHub only once when several reasons request it", () => {
    renderOverview(
      baseOverview({
        mergeReadiness: { _tag: "Blocked", blockers: [], warnings: [] },
        mergeReasons: [
          reason({
            code: "review_required",
            message: "Approval required by GitHub.",
            source: "github_pr_state",
            availability: "partial",
            openOnGitHub: true,
          }),
          reason({
            code: "blocked",
            message:
              "GitHub reports this merge is blocked, but none of the readable merge rules explain why.",
            source: "github_pr_state",
            availability: "partial",
            openOnGitHub: true,
          }),
        ],
        pullRequest: fixturePullRequest(),
      }),
    );
    expect(
      screen.getAllByRole("button", { name: "Open on GitHub" }),
    ).toHaveLength(1);
  });
});
