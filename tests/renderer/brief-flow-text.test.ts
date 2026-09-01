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
  it("draws a nested tree as diff text headed by its title, with tree guides showing each row's parent", () => {
    // Mirrors the maintainer's mock-up (the surviving rows of it, since its
    // "-" line was illustrating an older tree state rather than a sibling of
    // this one): a two-character marker in columns 0-1, then box-drawing
    // guides, then the label. No kind label -- that lives in the UI badge.
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
        "  Brief",
        "  ├── Start insight run",
        "+ │   ├── read patch",
        "+ │   ├── load PR description and commits",
        "+ │   └── build citation manifest",
        "  ├── Ask model for structured JSON",
        "+ ├── Validate citations and normalize output",
        "+ ├── Compute Reach locally",
        "  ├── Persist snapshot-bound Brief",
        "  └── Render result",
        "```",
      ].join("\n"),
    );
  });

  it("renders one fenced diff block per tree, each blank-line separated, headed by its title alone", () => {
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
      ["```diff", "  Tree one", "+ └── Only step", "```"].join("\n"),
    );
    expect(blocks[1]).toBe(
      ["```diff", "  Tree two", "- └── Other step", "```"].join("\n"),
    );
  });

  it("puts the marker in columns 0-1 and threads a │ continuation guide down each level of depth", () => {
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

    // <Toolbar> is the only root, so it draws as the last branch.
    expect(lines).toContain("  └── <Toolbar>");
    // <SaveButton> is <Toolbar>'s only (and so last) child: its parent's
    // guide segment is blank because <Toolbar> has no later sibling.
    expect(lines).toContain(`+ ${"    "}└── <SaveButton>`);
    // useSessionEvents() nests one level deeper again, still under two blank
    // continuation segments since neither ancestor has a later sibling.
    expect(lines).toContain(`+ ${"    "}${"    "}└── useSessionEvents()`);
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

    expect(lines).toContain("+ ├── Added step");
    expect(lines).toContain("- ├── Removed step");
    expect(lines).toContain("  └── Kept step");
    expect(text).not.toContain("+ └── Kept step");
    expect(text).not.toContain("- └── Kept step");
  });
});

describe("briefFlowKindLabel", () => {
  it("maps each kind to the human label its badge shows", () => {
    expect(briefFlowKindLabel("call_tree")).toBe("call tree");
    expect(briefFlowKindLabel("control_flow")).toBe("control flow");
    expect(briefFlowKindLabel("component")).toBe("component");
  });
});
