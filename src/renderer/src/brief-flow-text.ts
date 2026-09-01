import type { BriefFlow, BriefFlowNode } from "./brief-contracts";

/** A tree's `kind`, exactly as `briefFlowSchema` types it in `brief-contracts.ts`. */
type BriefFlowKind = BriefFlow["trees"][number]["kind"];

/**
 * The human label ADR 0039's kind badge shows, and the word the fenced diff
 * text's first line names each view by. Mirrors `BriefFlowKind` one for one.
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
 * box-drawing `guide` that draws its branch: one `"│   "` or `"    "` segment
 * per ancestor level (present if that ancestor has a later sibling, blank
 * spaces otherwise), followed by `"├── "` for a node with a later sibling of
 * its own or `"└── "` for the last child. Roots are the title line's
 * children, so the first root's guide starts with `"├── "` and the last
 * root's with `"└── "`.
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
 * (`"│   "` if that ancestor has a later sibling, else `"    "`), threaded
 * down through the recursion so each row can draw its own branch.
 */
export function flowRows(
  nodes: ReadonlyArray<BriefFlowNode>,
  ancestorGuides: ReadonlyArray<string> = [],
): ReadonlyArray<BriefFlowRow> {
  return nodes.flatMap((node, index) => {
    const isLastSibling = index === nodes.length - 1;
    const guide = `${ancestorGuides.join("")}${isLastSibling ? "└── " : "├── "}`;
    const childAncestorGuides = [
      ...ancestorGuides,
      isLastSibling ? "    " : "│   ",
    ];
    return [
      {
        label: node.label,
        change: node.change,
        citations: node.citations,
        depth: ancestorGuides.length,
        guide,
      },
      ...flowRows(node.children, childAncestorGuides),
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
 * ` ```diff ` block per tree, headed by a marker-column title line (`  ` plus
 * the tree's title, in that same two-character unchanged marker), then its
 * rows in the same order `flowRows` walks, each drawn with its box-drawing
 * guide. The kind label lives in the UI's badge, not in this text; no
 * citations and no counts travel into it either -- it exists to be pasted
 * into a PR comment or commit message, not to stand in for the rendered tree.
 */
export function briefFlowAsDiffText(flow: BriefFlow): string {
  return flow.trees
    .map((tree) => {
      const header = `  ${tree.title}`;
      const rows = flowRows(tree.nodes).map(flowRowLine);
      return ["```diff", header, ...rows, "```"].join("\n");
    })
    .join("\n\n");
}
