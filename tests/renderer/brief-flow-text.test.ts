import { describe, expect, it } from "vitest";

import {
  briefFlowAsDiffText,
  briefFlowKindLabel,
} from "../../src/renderer/src/brief-flow-text";
import type { BriefFlowNode } from "../../src/renderer/src/brief-contracts";

/** A Flow node fixture with no citations, since the diff text never carries them. */
const node = (
  label: string,
  change: BriefFlowNode["change"],
  children: ReadonlyArray<BriefFlowNode> = [],
): BriefFlowNode => ({ label, change, citations: [], children });

describe("briefFlowAsDiffText", () => {
  it("renders a nested tree as indentation-form diff text headed by its kind and title", () => {
    const text = briefFlowAsDiffText({
      trees: [
        {
          kind: "call_tree",
          title: "Save and update a route plan",
          nodes: [
            node("validateManualDays(command, suggestion)", "unchanged", [
              node("rejectEmptyDay(day)", "added"),
              node("requireFirstStop(day)", "added"),
            ]),
            node("persistMutationStops(tx, stops)", "unchanged"),
          ],
        },
      ],
    });

    expect(text).toBe(
      [
        "```diff",
        "  call tree · Save and update a route plan",
        "  validateManualDays(command, suggestion)",
        "+   rejectEmptyDay(day)",
        "+   requireFirstStop(day)",
        "  persistMutationStops(tx, stops)",
        "```",
      ].join("\n"),
    );
  });

  it("renders one fenced diff block per tree, each blank-line separated", () => {
    const text = briefFlowAsDiffText({
      trees: [
        {
          kind: "call_tree",
          title: "Tree one",
          nodes: [node("Only step", "added")],
        },
        {
          kind: "control_flow",
          title: "Tree two",
          nodes: [node("Other step", "removed")],
        },
      ],
    });

    const blocks = text.split("\n\n");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe(
      ["```diff", "  call tree · Tree one", "+ Only step", "```"].join("\n"),
    );
    expect(blocks[1]).toBe(
      ["```diff", "  control flow · Tree two", "- Other step", "```"].join(
        "\n",
      ),
    );
  });

  it("puts the marker in column 0 and adds two spaces of indentation per depth level", () => {
    const text = briefFlowAsDiffText({
      trees: [
        {
          kind: "component",
          title: "Toolbar",
          nodes: [
            node("<Toolbar>", "unchanged", [
              node("<SaveButton>", "added", [
                node("useSessionEvents()", "added"),
              ]),
            ]),
          ],
        },
      ],
    });
    const lines = text.split("\n");

    expect(lines).toContain("  <Toolbar>");
    expect(lines).toContain("+   <SaveButton>");
    expect(lines).toContain("+     useSessionEvents()");
  });

  it("gives an unchanged row a blank marker instead of a plus or minus", () => {
    const text = briefFlowAsDiffText({
      trees: [
        {
          kind: "control_flow",
          title: "Tree",
          nodes: [
            node("Added step", "added"),
            node("Removed step", "removed"),
            node("Kept step", "unchanged"),
          ],
        },
      ],
    });
    const lines = text.split("\n");

    expect(lines).toContain("+ Added step");
    expect(lines).toContain("- Removed step");
    expect(lines).toContain("  Kept step");
    expect(text).not.toContain("+ Kept step");
    expect(text).not.toContain("- Kept step");
  });
});

describe("briefFlowKindLabel", () => {
  it("maps each kind to the human label its badge and header line show", () => {
    expect(briefFlowKindLabel("call_tree")).toBe("call tree");
    expect(briefFlowKindLabel("control_flow")).toBe("control flow");
    expect(briefFlowKindLabel("component")).toBe("component");
  });
});
