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

/** One Flow node flattened out of its tree, with the depth it sits at. */
export type BriefFlowRow = {
  readonly label: string;
  readonly change: BriefFlowNode["change"];
  readonly citations: BriefFlowNode["citations"];
  readonly depth: number;
};

/**
 * Flattens a tree's nodes into rows in pre-order, depth-first, the same walk
 * both `briefFlowAsDiffText` and the reader's drawn rows follow -- the reason
 * the copied text and the rendered tree can never disagree about order.
 */
export function flowRows(
  nodes: ReadonlyArray<BriefFlowNode>,
  depth = 0,
): ReadonlyArray<BriefFlowRow> {
  return nodes.flatMap((node) => [
    {
      label: node.label,
      change: node.change,
      citations: node.citations,
      depth,
    },
    ...flowRows(node.children, depth + 1),
  ]);
}

/**
 * One row's line in the fenced diff text: a one-character marker sits in
 * column 0 (`+`, `-`, or a space for `unchanged`), and each level of depth
 * adds two more spaces after it -- the indentation form the maintainer's
 * `show-me` sketches use, not box-drawing connectors.
 */
function flowRowLine(row: BriefFlowRow): string {
  const marker =
    row.change === "added" ? "+" : row.change === "removed" ? "-" : " ";
  return `${marker}${"  ".repeat(row.depth)}${row.label}`;
}

/**
 * Renders every Flow tree as the fenced `+`/`-` diff text ADR 0039 shows: one
 * ` ```diff ` block per tree, headed by its kind label and title behind the
 * same one-character space marker every unchanged row carries, then its rows
 * in the same order `flowRows` walks. No citations and no counts travel into
 * this text -- it exists to be pasted into a PR comment or commit message,
 * not to stand in for the rendered tree.
 */
export function briefFlowAsDiffText(flow: BriefFlow): string {
  return flow.trees
    .map((tree) => {
      const header = ` ${briefFlowKindLabel(tree.kind)} · ${tree.title}`;
      const rows = flowRows(tree.nodes).map(flowRowLine);
      return ["```diff", header, ...rows, "```"].join("\n");
    })
    .join("\n\n");
}
