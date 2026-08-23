// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalReviewOverviewSheet,
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

  it("header reads Unknown, not Blocked, when the only blocker is mergeability_unknown", () => {
    const readiness: Readiness = {
      _tag: "Blocked",
      blockers: ["mergeability_unknown"],
      warnings: [],
    };
    renderOverview(baseOverview({ mergeReadiness: readiness }));
    expect(screen.queryByText("Blocked")).toBeNull();
    const header = screen.getByText("Unknown");
    expect(header.className).toContain("text-status-info");
    expect(header.className).not.toContain("text-destructive");
  });

  it("header still reads Blocked when mergeability_unknown accompanies a real blocker", () => {
    const readiness: Readiness = {
      _tag: "Blocked",
      blockers: ["mergeability_unknown", "conflicting"],
      warnings: [],
    };
    renderOverview(baseOverview({ mergeReadiness: readiness }));
    expect(screen.queryByText("Unknown")).toBeNull();
    const header = screen.getByText("Blocked");
    expect(header.className).toContain("text-destructive");
    expect(header.className).not.toContain("text-status-info");
  });

  it("header still reads Blocked with the destructive tone for a plain conflicting blocker", () => {
    const readiness: Readiness = {
      _tag: "Blocked",
      blockers: ["conflicting"],
      warnings: [],
    };
    renderOverview(baseOverview({ mergeReadiness: readiness }));
    const header = screen.getByText("Blocked");
    expect(header.className).toContain("text-destructive");
    expect(header.className).not.toContain("text-status-info");
  });

  it("leaves the Ready and NeedsAcknowledgement header labels unchanged", () => {
    renderOverview(
      baseOverview({
        mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
      }),
    );
    const readyHeader = screen.getByText("Ready to merge");
    expect(readyHeader.className).toContain("text-status-success");
    cleanup();

    renderOverview(
      baseOverview({
        mergeReadiness: {
          _tag: "NeedsAcknowledgement",
          blockers: [],
          warnings: ["request_changes"],
        },
      }),
    );
    const warningsHeader = screen.getByText("Warnings");
    expect(warningsHeader.className).toContain("text-status-warning");
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
