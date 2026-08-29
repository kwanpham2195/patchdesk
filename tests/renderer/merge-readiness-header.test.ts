import { describe, expect, it } from "vitest";

import {
  isUnconfirmedBlock,
  mergeReadinessLabel,
  mergeReadinessTone,
} from "../../src/renderer/src/components/pr-overview-sheet";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";

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
