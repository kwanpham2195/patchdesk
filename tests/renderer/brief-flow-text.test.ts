import { describe, expect, it } from "vitest";

import { briefFlowAsDiffText } from "../../src/renderer/src/brief-flow-text";
import type { BriefFlowNode } from "../../src/renderer/src/brief-contracts";

/** A Flow node fixture with no citations, since the diff text never carries them. */
const node = (
  label: string,
  change: BriefFlowNode["change"],
  children: ReadonlyArray<BriefFlowNode> = [],
): BriefFlowNode => ({ label, change, citations: [], children });

describe("briefFlowAsDiffText", () => {
  it("renders a nested tree with box-drawing connectors and a leading marker column", () => {
    const text = briefFlowAsDiffText({
      trees: [
        {
          title: "Insight run",
          nodes: [
            node("Start insight run", "unchanged", [
              node("prepare shared context", "removed"),
              node("read patch", "added"),
            ]),
            node("Render result", "unchanged"),
          ],
        },
      ],
    });

    expect(text).toBe(
      [
        "```diff",
        "  Insight run",
        "  ├── Start insight run",
        "- │   ├── prepare shared context",
        "+ │   └── read patch",
        "  └── Render result",
        "```",
      ].join("\n"),
    );
  });

  it("renders one fenced diff block per tree", () => {
    const text = briefFlowAsDiffText({
      trees: [
        { title: "Tree one", nodes: [node("Only step", "added")] },
        { title: "Tree two", nodes: [node("Other step", "removed")] },
      ],
    });

    const blocks = text.split("\n\n");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe(
      ["```diff", "  Tree one", "+ └── Only step", "```"].join("\n"),
    );
    expect(blocks[1]).toBe(
      ["```diff", "  Tree two", "- └── Other step", "```"].join("\n"),
    );
  });

  it("gives the last child of a branch the closing connector", () => {
    const text = briefFlowAsDiffText({
      trees: [
        {
          title: "Tree",
          nodes: [
            node("First", "unchanged"),
            node("Second", "unchanged"),
            node("Last", "unchanged"),
          ],
        },
      ],
    });

    expect(text).toBe(
      [
        "```diff",
        "  Tree",
        "  ├── First",
        "  ├── Second",
        "  └── Last",
        "```",
      ].join("\n"),
    );
  });

  it("puts the marker in column 0 and gives an unchanged line two spaces instead", () => {
    const text = briefFlowAsDiffText({
      trees: [
        {
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

    expect(lines).toContain("+ ├── Added step");
    expect(lines).toContain("- ├── Removed step");
    expect(lines).toContain("  └── Kept step");
    expect(lines.some((line) => line.startsWith("+ "))).toBe(true);
    expect(lines.some((line) => line.startsWith("  └── Kept"))).toBe(true);
    expect(text).not.toContain("+ Kept step");
    expect(text).not.toContain("- Kept step");
  });
});
