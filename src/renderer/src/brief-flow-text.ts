import type { BriefFlow, BriefFlowNode } from "./brief-contracts";

/**
 * Renders every Flow tree as the fenced `+`/`-` diff text ADR 0039 shows: one
 * ` ```diff ` block per tree, the title as its first line, then the nodes with
 * box-drawing connectors so the nesting still reads once the last child of a
 * branch ends. The `+`/`-` marker always opens the line, in column 0, because
 * that is the only column a ```diff fence colours; the tree's own indentation
 * follows it, so an unchanged line keeps the same left edge with two spaces
 * standing in for a marker. No citations and no counts travel into this text
 * -- it exists to be pasted into a PR comment or commit message, not to stand
 * in for the rendered tree.
 */
export function briefFlowAsDiffText(flow: BriefFlow): string {
  return flow.trees
    .map((tree) => {
      const lines = [`  ${tree.title}`];
      appendNodeLines(tree.nodes, "", lines);
      return ["```diff", ...lines, "```"].join("\n");
    })
    .join("\n\n");
}

/**
 * Appends one level of the tree, depth-first, threading the parent's
 * continuation prefix down: a non-last sibling continues its branch with
 * `│   ` below it, a last sibling continues with plain spaces, because
 * nothing is left of it to draw a line past.
 */
function appendNodeLines(
  nodes: ReadonlyArray<BriefFlowNode>,
  prefix: string,
  lines: Array<string>,
): void {
  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const marker =
      node.change === "added" ? "+ " : node.change === "removed" ? "- " : "  ";
    lines.push(`${marker}${prefix}${connector}${node.label}`);
    const childPrefix = `${prefix}${isLast ? "    " : "│   "}`;
    appendNodeLines(node.children, childPrefix, lines);
  });
}
