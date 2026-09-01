import type { BriefFlow, BriefFlowNode } from "./brief-contracts";

/** A tree's `kind`, exactly as `briefFlowSchema` types it in `brief-contracts.ts`. */
type BriefFlowKind = BriefFlow["trees"][number]["kind"];

/**
 * The human label ADR 0039's kind badge shows. Mirrors `BriefFlowKind` one
 * for one.
 */
const FLOW_KIND_LABELS = {
  call_tree: "call tree",
  control_flow: "control flow",
  component: "component",
} as const satisfies Record<BriefFlowKind, string>;

/** "call tree" / "control flow" / "component": the word a kind badge shows. */
export function briefFlowKindLabel(kind: BriefFlowKind): string {
  return FLOW_KIND_LABELS[kind];
}

/**
 * One Flow node flattened out of its tree, with the depth it sits at and the
 * box-drawing `guide` that draws its branch. A root (depth 0) is an
 * independent entry point, not a child of the view's title, so its `guide`
 * is empty -- it draws flush-left with no connector. From depth 1 down, the
 * guide is one `"│   "` or `"    "` segment per ancestor *below the root*
 * (present if that ancestor has a later sibling, blank spaces otherwise),
 * followed by `"├── "` for a node with a later sibling of its own or
 * `"└── "` for the last child. A root's later sibling root never
 * contributes a `"│   "` column to that root's descendants -- guides show
 * nesting within one root's subtree, not across roots.
 */
export type BriefFlowRow = {
  readonly label: string;
  readonly change: BriefFlowNode["change"];
  readonly citations: BriefFlowNode["citations"];
  readonly depth: number;
  readonly guide: string;
};

/**
 * Flattens a tree's nodes into rows in pre-order, depth-first, the same walk
 * both `briefFlowAsDiffText` and the reader's drawn rows follow -- the reason
 * the copied text and the rendered tree can never disagree about order.
 * `ancestorGuides` carries one continuation segment per ancestor level
 * *below the root* (`"│   "` if that ancestor has a later sibling, else
 * `"    "`), threaded down through the recursion so each row can draw its
 * own branch; `depth` tracks how deep the current `nodes` sit, so a root
 * call (`depth` 0) can skip both its own connector and its contribution to
 * its children's `ancestorGuides` -- a root's sibling never draws a `"│   "`
 * column under it.
 */
export function flowRows(
  nodes: ReadonlyArray<BriefFlowNode>,
  ancestorGuides: ReadonlyArray<string> = [],
  depth = 0,
): ReadonlyArray<BriefFlowRow> {
  return nodes.flatMap((node, index) => {
    const isLastSibling = index === nodes.length - 1;
    const guide =
      depth === 0
        ? ""
        : `${ancestorGuides.join("")}${isLastSibling ? "└── " : "├── "}`;
    const childAncestorGuides =
      depth === 0
        ? ancestorGuides
        : [...ancestorGuides, isLastSibling ? "    " : "│   "];
    return [
      {
        label: node.label,
        change: node.change,
        citations: node.citations,
        depth,
        guide,
      },
      ...flowRows(node.children, childAncestorGuides, depth + 1),
    ];
  });
}

/**
 * One row's line in the fenced diff text: a two-character marker (`"+ "`,
 * `"- "`, or `"  "` for `unchanged`) sits in columns 0-1, then the row's
 * box-drawing `guide`, then its label -- the same tree the reader draws, so
 * the pasted block reads as the drawn tree.
 */
function flowRowLine(row: BriefFlowRow): string {
  const marker =
    row.change === "added" ? "+ " : row.change === "removed" ? "- " : "  ";
  return `${marker}${row.guide}${row.label}`;
}

/**
 * Renders every Flow tree as the fenced `+`/`-` diff text ADR 0039 shows: one
 * ` ```diff ` block per tree, its rows in the same order `flowRows` walks,
 * each drawn with its box-drawing guide. The title does not repeat inside
 * the block -- the view header above it already carries that -- so a root
 * row (an independent entry point, flush-left with an empty guide) is the
 * block's first line. The kind label lives in the UI's badge, not in this
 * text; no citations and no counts travel into it either -- it exists to be
 * pasted into a PR comment or commit message, not to stand in for the
 * rendered tree.
 */
export function briefFlowAsDiffText(flow: BriefFlow): string {
  return flow.trees
    .map((tree) => {
      const rows = flowRows(tree.nodes).map(flowRowLine);
      return ["```diff", ...rows, "```"].join("\n");
    })
    .join("\n\n");
}
