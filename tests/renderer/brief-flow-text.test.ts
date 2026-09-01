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
  it("draws a nested tree as diff text with roots flush-left and guides nested within each root's subtree", () => {
    // A view's roots are independent entry points, not children of the
    // title, so they draw flush-left with no connector; guides start inside
    // each root's own subtree. A two-character marker sits in columns 0-1,
    // then box-drawing guides, then the label. No title line and no kind
    // label -- the title lives in the view header, the kind in the UI badge.
    const text = briefFlowAsDiffText({
      trees: [
        {
          kind: "call_tree",
          title: "Brief",
          nodes: [
            node("Start insight run", "unchanged", [
              node("read patch", "added"),
              node("load PR description and commits", "added"),
              node("build citation manifest", "added"),
            ]),
            node("Ask model for structured JSON", "unchanged"),
            node("Validate citations and normalize output", "added"),
            node("Compute Reach locally", "added"),
            node("Persist snapshot-bound Brief", "unchanged"),
            node("Render result", "unchanged"),
          ],
        },
      ],
    });

    expect(text).toBe(
      [
        "```diff",
        "  Start insight run",
        "+ ├── read patch",
        "+ ├── load PR description and commits",
        "+ └── build citation manifest",
        "  Ask model for structured JSON",
        "+ Validate citations and normalize output",
        "+ Compute Reach locally",
        "  Persist snapshot-bound Brief",
        "  Render result",
        "```",
      ].join("\n"),
    );
  });

  it("renders one fenced diff block per tree, each blank-line separated, with no title line", () => {
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
    expect(blocks[0]).toBe(["```diff", "+ Only step", "```"].join("\n"));
    expect(blocks[1]).toBe(["```diff", "- Other step", "```"].join("\n"));
  });

  it("draws a lone root flush-left with an empty guide, even though it has no later sibling", () => {
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

    // <Toolbar> is the tree's only root: flush-left, no connector, even
    // though a root with no later sibling used to draw as "└── ".
    expect(lines).toContain("  <Toolbar>");
    // <SaveButton> is <Toolbar>'s only (and so last) child: depth 1, so its
    // guide is just its own connector -- nothing carries over from the root.
    expect(lines).toContain("+ └── <SaveButton>");
    // useSessionEvents() nests one level deeper again: one blank
    // continuation segment for <SaveButton> (no later sibling), then its
    // own connector.
    expect(lines).toContain(`+ ${"    "}└── useSessionEvents()`);
  });

  it("gives an unchanged row a blank marker and draws └── only for the last sibling", () => {
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

    // All three are roots (depth 0): flush-left, no connector at all, even
    // for the marked-up added/removed rows.
    expect(lines).toContain("+ Added step");
    expect(lines).toContain("- Removed step");
    expect(lines).toContain("  Kept step");
  });

  it("does not let a root's later sibling root draw a │ column under its subtree", () => {
    // Two roots, each with two levels of nested children. Root "a" has a
    // later sibling root "b" -- that must not add a "│   " column to any of
    // "a"'s descendants, since guides only track nesting within one root's
    // own subtree, never siblings at the root level.
    const text = briefFlowAsDiffText({
      trees: [
        {
          kind: "call_tree",
          title: "Tree",
          nodes: [
            node("a", "unchanged", [
              node("a1", "unchanged", [
                node("a1x", "added"),
                node("a1y", "added"),
              ]),
              node("a2", "unchanged"),
            ]),
            node("b", "unchanged"),
          ],
        },
      ],
    });

    expect(text).toBe(
      [
        "```diff",
        "  a",
        "  ├── a1",
        "+ │   ├── a1x",
        "+ │   └── a1y",
        "  └── a2",
        "  b",
        "```",
      ].join("\n"),
    );
  });
});

describe("briefFlowKindLabel", () => {
  it("maps each kind to the human label its badge shows", () => {
    expect(briefFlowKindLabel("call_tree")).toBe("call tree");
    expect(briefFlowKindLabel("control_flow")).toBe("control flow");
    expect(briefFlowKindLabel("component")).toBe("component");
  });
});
