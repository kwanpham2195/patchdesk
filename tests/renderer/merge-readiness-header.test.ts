import { describe, expect, it } from "vitest";

import {
  isUnconfirmedBlock,
  mergeReadinessLabel,
  mergeReadinessTone,
} from "../../src/renderer/src/components/pr-overview-sheet";
import {
  blockedMergeChip,
  mergeBlockerLabels,
} from "../../src/renderer/src/components/merge-readiness-items";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import type { MergeDisplayReason } from "../../src/domain/github-context";

type Tag = WorkbenchResponse["mergeReadiness"]["_tag"];

/**
 * The tone tokens the header rule may return. They are written out here
 * rather than imported, so the test pins the semantic token each state gets
 * instead of restating whatever the component happens to hold.
 */
const successTone = "text-status-success";
const warningTone = "text-status-warning";
const destructiveTone = "text-destructive";
const infoTone = "text-status-info";
const mutedTone = "text-muted-foreground";

describe("isUnconfirmedBlock", () => {
  it("is true only for a Blocked tag whose single blocker is mergeability_unknown", () => {
    // ADR 0027, "Unknown is not failure": this is Patchdesk saying it does
    // not yet know GitHub's merge status, not GitHub confirming a block.
    expect(isUnconfirmedBlock("Blocked", ["mergeability_unknown"])).toBe(true);
  });

  it("is false once any other blocker accompanies mergeability_unknown", () => {
    expect(
      isUnconfirmedBlock("Blocked", ["mergeability_unknown", "conflicting"]),
    ).toBe(false);
    expect(
      isUnconfirmedBlock("Blocked", ["conflicting", "mergeability_unknown"]),
    ).toBe(false);
  });

  it("is false for a plain confirmed block and for a Blocked tag with no blockers", () => {
    expect(isUnconfirmedBlock("Blocked", ["conflicting"])).toBe(false);
    expect(isUnconfirmedBlock("Blocked", [])).toBe(false);
  });

  it("is false for every tag that is not Blocked, whatever the blockers say", () => {
    for (const tag of ["Ready", "NeedsAcknowledgement"] satisfies Tag[]) {
      expect(isUnconfirmedBlock(tag, ["mergeability_unknown"])).toBe(false);
    }
  });
});

describe("mergeReadinessLabel and mergeReadinessTone", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly tag: Tag;
    readonly blockers: ReadonlyArray<string>;
    readonly label: string;
    readonly tone: string;
  }> = [
    {
      name: "an unconfirmed block reads Unknown with the neutral info tone",
      tag: "Blocked",
      blockers: ["mergeability_unknown"],
      label: "Unknown",
      tone: infoTone,
    },
    {
      name: "mergeability_unknown alongside a real blocker reads Blocked",
      tag: "Blocked",
      blockers: ["mergeability_unknown", "conflicting"],
      label: "Blocked",
      tone: destructiveTone,
    },
    {
      name: "a plain confirmed block reads Blocked",
      tag: "Blocked",
      blockers: ["conflicting"],
      label: "Blocked",
      tone: destructiveTone,
    },
    {
      name: "a block made only of the draft state reads Draft with the muted tone",
      tag: "Blocked",
      blockers: ["draft"],
      label: "Draft",
      tone: mutedTone,
    },
    {
      name: "a block of draft and closed states reads Draft with the muted tone",
      tag: "Blocked",
      blockers: ["closed", "draft"],
      label: "Draft",
      tone: mutedTone,
    },
    {
      name: "a draft alongside a real blocker reads Blocked",
      tag: "Blocked",
      blockers: ["draft", "conflicting"],
      label: "Blocked",
      tone: destructiveTone,
    },
    {
      name: "a Ready tag reads Ready to merge",
      tag: "Ready",
      blockers: [],
      label: "Ready to merge",
      tone: successTone,
    },
    {
      name: "a NeedsAcknowledgement tag reads Warnings",
      tag: "NeedsAcknowledgement",
      blockers: [],
      label: "Warnings",
      tone: warningTone,
    },
  ];

  it.each(cases)("$name", ({ tag, blockers, label, tone }) => {
    expect(mergeReadinessLabel(tag, blockers)).toBe(label);
    expect(mergeReadinessTone(tag, blockers)).toBe(tone);
  });

  it("never gives an unconfirmed block the destructive treatment the body withholds", () => {
    expect(mergeReadinessTone("Blocked", ["mergeability_unknown"])).not.toBe(
      destructiveTone,
    );
  });
});

describe("mergeBlockerLabels", () => {
  const reason = (code: MergeDisplayReason["code"]): MergeDisplayReason => ({
    code,
    message: `${code} message`,
    source: "github_pr_state",
    availability: "available",
    openOnGitHub: false,
  });
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly blockers: ReadonlyArray<string>;
    readonly reasons: ReadonlyArray<MergeDisplayReason>;
    readonly label: string | undefined;
  }> = [
    { name: "draft blocker", blockers: ["draft"], reasons: [], label: "Draft" },
    {
      name: "conflicting blocker",
      blockers: ["conflicting"],
      reasons: [],
      label: "Conflicts",
    },
    {
      name: "required check blocker",
      blockers: ["required_check"],
      reasons: [],
      label: "Checks",
    },
    {
      name: "failing check blocker",
      blockers: ["failing_check"],
      reasons: [],
      label: "Checks",
    },
    {
      name: "GitHub review blocker",
      blockers: ["github_review"],
      reasons: [],
      label: "Review",
    },
    {
      name: "stale head blocker",
      blockers: ["stale_head"],
      reasons: [],
      label: "Outdated",
    },
    {
      name: "closed blocker",
      blockers: ["closed"],
      reasons: [],
      label: "Closed",
    },
    {
      name: "analysis finding blocker",
      blockers: ["analysis_finding"],
      reasons: [],
      label: "Findings",
    },
    {
      name: "the first of several blockers in evaluation order",
      blockers: ["draft", "conflicting", "failing_check"],
      reasons: [],
      label: "Draft",
    },
    {
      name: "a GitHub display reason ahead of the raw blocker it restates",
      blockers: ["merge_blocked"],
      reasons: [reason("behind")],
      label: "Behind base",
    },
    {
      name: "a draft ahead of GitHub's review reason",
      blockers: ["draft", "github_review"],
      reasons: [reason("review_required")],
      label: "Draft",
    },
    {
      name: "an outdated head ahead of every other cause",
      blockers: ["stale_head", "draft", "conflicting"],
      reasons: [reason("conflicts")],
      label: "Outdated",
    },
    {
      name: "review required reason",
      blockers: [],
      reasons: [reason("review_required"), reason("checks")],
      label: "Review",
    },
    {
      name: "changes requested reason",
      blockers: [],
      reasons: [reason("changes_requested")],
      label: "Changes requested",
    },
    {
      name: "behind reason",
      blockers: [],
      reasons: [reason("behind")],
      label: "Behind base",
    },
    {
      name: "checks reason",
      blockers: [],
      reasons: [reason("checks")],
      label: "Checks",
    },
    {
      name: "no named cause for the generic blocked reason",
      blockers: ["merge_blocked"],
      reasons: [reason("blocked")],
      label: undefined,
    },
    {
      name: "no named cause for GitHub's generic merge_blocked",
      blockers: ["merge_blocked"],
      reasons: [],
      label: undefined,
    },
    {
      name: "no named cause for unknown mergeability",
      blockers: ["mergeability_unknown"],
      reasons: [],
      label: undefined,
    },
    { name: "no blockers at all", blockers: [], reasons: [], label: undefined },
  ];

  it.each(cases)("names $name first", ({ blockers, reasons, label }) => {
    expect(mergeBlockerLabels(blockers, reasons)[0]).toBe(label);
  });

  it("lists every named cause once, in list order", () => {
    expect(
      mergeBlockerLabels(
        ["draft", "conflicting", "required_check", "failing_check"],
        [reason("conflicts")],
      ),
    ).toEqual(["Draft", "Conflicts", "Checks"]);
  });
});

describe("blockedMergeChip", () => {
  it.each([
    {
      name: "no named cause reads plain Blocked",
      labels: [],
      text: "Blocked",
      accessibleName: "blocked",
    },
    {
      name: "one cause is named without a count",
      labels: ["Draft"],
      text: "Blocked · Draft",
      accessibleName: "blocked: draft",
    },
    {
      name: "further causes are counted, and all are named for assistive tech",
      labels: ["Draft", "Conflicts", "Checks"],
      text: "Blocked · Draft +2",
      accessibleName: "blocked: draft, conflicts, checks",
    },
  ])("$name", ({ labels, text, accessibleName }) => {
    expect(blockedMergeChip(labels)).toEqual({ text, accessibleName });
  });
});
