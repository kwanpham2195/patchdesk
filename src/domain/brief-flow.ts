import * as v from "valibot";

import { resolveBriefCitations, type BriefCitation } from "./brief";

/*
 * The Brief reader draws this block as "Flow": a before/after tree of a
 * runtime sequence, one tree per pipeline the patch touches.
 *
 * Flow cites hunks only -- only the diff can show that a step was added or
 * removed, so a description or commit alias never counts as evidence of a
 * code change, no matter how it is paired with a real hunk. An `unchanged`
 * step is the spine connecting the changed ones: it needs no citation at
 * all, but anything it does cite is resolved by the same hunk-only rule, and
 * a non-hunk or unknown alias is discarded and counted exactly like one on a
 * changed step.
 *
 * An `added`/`removed` step that ends with no surviving hunk citation is
 * dropped, and its whole proposed subtree goes with it -- a changed step
 * Patchdesk cannot back up is not shown, and nothing invented underneath an
 * invented step survives either. A tree left with no surviving changed step
 * at any depth says nothing changed, so the whole tree is dropped; only the
 * first `MAX_FLOW_TREES` survivors after that are kept, in the order the
 * model proposed them.
 */

/** Whether one Flow step is new, gone, or the spine connecting the changed ones. */
export type BriefFlowChange = "added" | "removed" | "unchanged";

/** One step of a Flow tree, already checked against the citation manifest. */
export type BriefFlowNode = {
  readonly label: string;
  readonly change: BriefFlowChange;
  readonly citations: ReadonlyArray<BriefCitation>;
  readonly children: ReadonlyArray<BriefFlowNode>;
};

/** One before/after tree: a named pipeline, and the steps that make it up. */
export type BriefFlowTree = {
  readonly title: string;
  readonly nodes: ReadonlyArray<BriefFlowNode>;
};

/** The Flow block: up to `MAX_FLOW_TREES` before/after trees. */
export type BriefFlow = {
  readonly trees: ReadonlyArray<BriefFlowTree>;
};

/** Kept trees per Brief -- past this, Flow starts reading as the whole diff again. */
const MAX_FLOW_TREES = 2;
/** Kept node depth; a root node is depth 1. */
const MAX_FLOW_DEPTH = 3;
/** Pre-order nodes visited per tree before the rest of that tree is dropped. */
const MAX_FLOW_NODES_PER_TREE = 15;
/** Kept label length, after collapsing the raw label to one line. */
const MAX_FLOW_LABEL_LENGTH = 80;
/** Raw label length the schema accepts, before normalization drops the long ones. */
const MAX_FLOW_LABEL_INPUT_LENGTH = 200;
/** Raw tree title length the schema accepts. */
const MAX_FLOW_TITLE_INPUT_LENGTH = 120;
/** Raw citations the schema accepts per node; mirrors `MAX_CITATIONS_PER_ITEM` in brief.ts. */
const MAX_FLOW_CITATIONS_PER_NODE = 8;
/** Raw children (and root nodes) the schema accepts per level -- well past `MAX_FLOW_NODES_PER_TREE`, so the pre-order cap, not the schema, decides what survives. */
const MAX_FLOW_CHILDREN_PER_NODE = 20;
/** Raw trees the schema accepts per Brief; mirrors `MAX_FLOW_TREES` the same way. */
const MAX_FLOW_TREES_INPUT = 5;
/** Raw alias length the schema accepts; mirrors `MAX_ALIAS_LENGTH` in brief.ts. */
const MAX_FLOW_ALIAS_LENGTH = 16;

/**
 * Raw shape of one Flow node before Patchdesk resolves its citations. The
 * optional fields carry an explicit `| undefined` because `v.optional`
 * infers a present-but-`undefined` value, which `exactOptionalPropertyTypes`
 * would otherwise reject on the `?:` modifier alone.
 */
type BriefFlowNodeOutput = {
  readonly label: string;
  readonly change: BriefFlowChange;
  readonly citations?: ReadonlyArray<string> | undefined;
  readonly children?: ReadonlyArray<BriefFlowNodeOutput> | undefined;
};

/**
 * A Flow node is recursive, so its schema refers to itself through `v.lazy`
 * at the `children` field -- the object literal here is otherwise the same
 * shape `v.strictObject` builds for any other Brief block.
 */
const briefFlowNodeOutputSchema: v.GenericSchema<BriefFlowNodeOutput> =
  v.strictObject({
    label: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(MAX_FLOW_LABEL_INPUT_LENGTH),
    ),
    change: v.picklist(["added", "removed", "unchanged"]),
    citations: v.optional(
      v.pipe(
        v.array(v.pipe(v.string(), v.maxLength(MAX_FLOW_ALIAS_LENGTH))),
        v.maxLength(MAX_FLOW_CITATIONS_PER_NODE),
      ),
    ),
    children: v.optional(
      v.pipe(
        v.array(v.lazy(() => briefFlowNodeOutputSchema)),
        v.maxLength(MAX_FLOW_CHILDREN_PER_NODE),
      ),
    ),
  });

/**
 * The Flow keys a Brief child may return: up to `MAX_FLOW_TREES_INPUT`
 * before/after trees, each a title and its root nodes.
 */
export const briefFlowOutputSchema = v.optional(
  v.pipe(
    v.array(
      v.strictObject({
        title: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(MAX_FLOW_TITLE_INPUT_LENGTH),
        ),
        nodes: v.pipe(
          v.array(briefFlowNodeOutputSchema),
          v.maxLength(MAX_FLOW_CHILDREN_PER_NODE),
        ),
      }),
    ),
    v.maxLength(MAX_FLOW_TREES_INPUT),
  ),
);

export type BriefFlowOutput = v.InferOutput<typeof briefFlowOutputSchema>;

/** The Flow block that survived normalization, and what it cost in citations. */
export type NormalizedBriefFlow = {
  readonly value: BriefFlow | undefined;
  readonly rejected: number;
};

/** Pre-order bookkeeping shared across one tree's whole walk. */
type FlowWalkContext = {
  rejected: number;
  visited: number;
};

/** The hunk citations one Flow node resolved to, and what it cost. */
type ResolvedFlowCitations = {
  readonly citations: ReadonlyArray<BriefCitation>;
  readonly rejected: number;
};

/** One line, collapsed and trimmed, the way every other Brief label is shown. */
function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Resolves one node's proposed aliases, keeping only hunk citations. Flow
 * cites hunks only, so `resolveBriefCitations` first drops an unknown alias
 * or a repeat the same node already used, and this then drops a citation
 * that resolved to a description or commit entry -- counted toward
 * `rejected` exactly like the aliases `resolveBriefCitations` already
 * rejected.
 */
function resolveFlowCitations(
  aliases: ReadonlyArray<string>,
  byAlias: ReadonlyMap<string, BriefCitation>,
): ResolvedFlowCitations {
  const resolved = resolveBriefCitations(aliases, byAlias);
  const citations: Array<BriefCitation> = [];
  let rejected = resolved.rejected;
  for (const citation of resolved.citations) {
    if (citation.kind === "hunk") citations.push(citation);
    else rejected += 1;
  }
  return { citations, rejected };
}

/**
 * Counts one proposed subtree node by node, for the citation-rule cascade
 * only: when a changed step is dropped for citing no hunk, everything the
 * model proposed underneath it is gone too, without being depth-checked,
 * label-checked, or citation-checked on its own -- it is counted once per
 * node purely because its parent did not survive.
 */
function countFlowDescendants(
  rawNodes: ReadonlyArray<BriefFlowNodeOutput>,
): number {
  let count = 0;
  for (const raw of rawNodes) {
    count += 1;
    count += countFlowDescendants(raw.children ?? []);
  }
  return count;
}

/**
 * Walks one tree's proposed nodes in pre-order, applying, in this order: the
 * `MAX_FLOW_NODES_PER_TREE` cap, the `MAX_FLOW_DEPTH` cap, the label check,
 * and finally -- for `added`/`removed` nodes only -- the rule that a changed
 * step must keep at least one hunk citation or it (and its whole proposed
 * subtree) is dropped. `unchanged` nodes need no citation at all, but any
 * they carry are still resolved so a non-hunk or unknown alias still counts
 * toward `rejected`.
 */
function walkFlowNodes(
  rawNodes: ReadonlyArray<BriefFlowNodeOutput>,
  depth: number,
  byAlias: ReadonlyMap<string, BriefCitation>,
  ctx: FlowWalkContext,
): ReadonlyArray<BriefFlowNode> {
  const kept: Array<BriefFlowNode> = [];
  for (const raw of rawNodes) {
    ctx.visited += 1;
    if (ctx.visited > MAX_FLOW_NODES_PER_TREE) {
      ctx.rejected += 1;
      continue;
    }
    if (depth > MAX_FLOW_DEPTH) {
      ctx.rejected += 1;
      continue;
    }
    // A whitespace-only label cannot fail `v.minLength(1)` on the raw string,
    // so it is checked here instead, right beside the length cap.
    const label = singleLine(raw.label);
    if (label === "" || label.length > MAX_FLOW_LABEL_LENGTH) {
      ctx.rejected += 1;
      continue;
    }

    const resolved = resolveFlowCitations(raw.citations ?? [], byAlias);
    ctx.rejected += resolved.rejected;

    if (raw.change !== "unchanged" && resolved.citations.length === 0) {
      ctx.rejected += 1 + countFlowDescendants(raw.children ?? []);
      continue;
    }

    const children = walkFlowNodes(raw.children ?? [], depth + 1, byAlias, ctx);
    kept.push({
      label,
      change: raw.change,
      citations: resolved.citations,
      children,
    });
  }
  return kept;
}

/** True when a kept tree has a surviving `added`/`removed` node, at any depth. */
function anyFlowNodeChanged(nodes: ReadonlyArray<BriefFlowNode>): boolean {
  return nodes.some(
    (node) => node.change !== "unchanged" || anyFlowNodeChanged(node.children),
  );
}

/**
 * A blank tree title falls back to a placeholder rather than dropping the
 * tree -- the title is a label for the reader, not evidence, so there is
 * nothing to verify about it.
 */
function normalizeFlowTitle(rawTitle: string): string {
  const title = singleLine(rawTitle);
  return title === "" ? "Untitled flow" : title;
}

/**
 * Normalizes a proposed Flow block against the Brief's citation manifest.
 * Never throws and never fails the whole Brief: a missing `flow` simply
 * means the block was not offered, so it returns with no `value` and
 * nothing rejected.
 *
 * Every node is checked for depth, the per-tree node cap, label length, and
 * -- for a changed step -- the hunk-citation rule; a tree left with no
 * surviving changed node is dropped whole, and only the first
 * `MAX_FLOW_TREES` surviving trees, in the model's proposed order, are kept.
 */
export function normalizeBriefFlow(
  raw: BriefFlowOutput,
  byAlias: ReadonlyMap<string, BriefCitation>,
): NormalizedBriefFlow {
  if (raw === undefined) return { value: undefined, rejected: 0 };

  let rejected = 0;
  const survivors: Array<BriefFlowTree> = [];

  for (const rawTree of raw) {
    const ctx: FlowWalkContext = { rejected: 0, visited: 0 };
    const nodes = walkFlowNodes(rawTree.nodes, 1, byAlias, ctx);
    rejected += ctx.rejected;

    if (!anyFlowNodeChanged(nodes)) {
      rejected += 1;
      continue;
    }
    survivors.push({ title: normalizeFlowTitle(rawTree.title), nodes });
  }

  const trees: Array<BriefFlowTree> = [];
  for (const tree of survivors) {
    if (trees.length >= MAX_FLOW_TREES) {
      rejected += 1;
      continue;
    }
    trees.push(tree);
  }

  return trees.length === 0
    ? { value: undefined, rejected }
    : { value: { trees }, rejected };
}

/**
 * Every hunk citation a kept Flow cites, walked node by node in tree order,
 * so `cutCitedHunks` can cut a preview for a Flow chip the same way it does
 * for a Goal or description-drift citation.
 */
export function flowCitations(
  flow: BriefFlow | undefined,
): ReadonlyArray<BriefCitation> {
  if (flow === undefined) return [];
  const citations: Array<BriefCitation> = [];
  const walk = (nodes: ReadonlyArray<BriefFlowNode>): void => {
    for (const node of nodes) {
      citations.push(...node.citations);
      walk(node.children);
    }
  };
  for (const tree of flow.trees) walk(tree.nodes);
  return citations;
}
