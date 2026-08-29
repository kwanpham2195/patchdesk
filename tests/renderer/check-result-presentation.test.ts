import { describe, expect, it } from "vitest";

import { presentOverallCheckResult } from "../../src/renderer/src/components/review-checks";
import type { CheckSummary } from "../../src/domain/github-context";

type Overall = CheckSummary["overall"];
type Freshness = Parameters<typeof presentOverallCheckResult>[1];

describe("presentOverallCheckResult", () => {
  it.each([
    ["passing", "Passing", "passed", "text-status-success"],
    ["failing", "Failing", "failed", "text-destructive"],
    ["pending", "In progress", "pending", "text-status-warning"],
    ["skipped", "Skipped", "other", "text-muted-foreground"],
    ["unknown", "Unknown", "other", "text-muted-foreground"],
  ] satisfies ReadonlyArray<[Overall, string, string, string]>)(
    "maps the %s aggregate to %s",
    (overall, label, kind, treatment) => {
      const presented = presentOverallCheckResult(overall, "fresh");
      expect(presented.label).toBe(label);
      expect(presented.kind).toBe(kind);
      expect(presented.treatment).toBe(treatment);
    },
  );

  it.each([
    ["not_refreshed", "Not refreshed"],
    ["unavailable", "Unavailable"],
  ] satisfies ReadonlyArray<[Freshness, string]>)(
    "reports %s freshness instead of an aggregate Patchdesk cannot vouch for",
    (freshness, label) => {
      // ADR 0032: the screen refreshes only when asked, so a stale or
      // unread aggregate must not be presented as a current GitHub answer.
      // Every aggregate is overridden, including a passing one.
      for (const overall of [
        "passing",
        "failing",
        "pending",
        "skipped",
        "unknown",
      ] satisfies Overall[]) {
        const presented = presentOverallCheckResult(overall, freshness);
        expect(presented.label).toBe(label);
        expect(presented.kind).toBe("other");
        expect(presented.treatment).toBe("text-muted-foreground");
      }
    },
  );

  it.each([
    "fresh",
    "stale",
    "updates_available",
    undefined,
  ] satisfies Freshness[])(
    "lets the aggregate through for %s freshness",
    (freshness) => {
      expect(presentOverallCheckResult("failing", freshness).label).toBe(
        "Failing",
      );
    },
  );

  it("gives a failing aggregate a treatment no passing one shares", () => {
    expect(presentOverallCheckResult("failing", "fresh").treatment).not.toBe(
      presentOverallCheckResult("passing", "fresh").treatment,
    );
  });

  it("gives every outcome an icon, so no row renders label-only", () => {
    for (const overall of [
      "passing",
      "failing",
      "pending",
      "skipped",
      "unknown",
    ] satisfies Overall[]) {
      expect(presentOverallCheckResult(overall, "fresh").Icon).toBeTruthy();
    }
  });
});
