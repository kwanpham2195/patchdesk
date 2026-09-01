import * as v from "valibot";

import type { BriefCitation } from "./brief-citation";
import { resolveBriefCitations } from "./brief-citation-resolution";

/*
 * The Brief reader draws this block as "Flow": a before/after tree of a
 * runtime sequence. Every tree carries a `kind` -- call_tree, control_flow,
 * or component -- and the Brief keeps at most one tree per kind, so up to
 * `MAX_FLOW_TREES` trees survive, one for each kind the patch changes.
 *
 * Citations are best effort: an added or removed step keeps its place with
 * or without a hunk citation; a discarded alias or an uncited changed step
 * counts toward `rejected` so the Brief reads as partially verified, but the
 * tree is never cut for it. Only the diff can prove a step changed, so
 * description and commit aliases are still discarded, no matter how they are
 * paired with a real hunk. An `unchanged` step is the spine connecting the
 * changed ones: it needs no citation at all, but anything it does cite is
 * resolved by the same hunk-only rule, and a non-hunk or unknown alias is
 * discarded and counted exactly like one on a changed step.
 *
 * A tree left with no surviving changed step at any depth says nothing
 * changed, so the whole tree is dropped; of the survivors, a second tree of
 * a kind already kept is dropped too (input order wins), and only the first
 * `MAX_FLOW_TREES` survivors after that are kept, in the order the model
 * proposed them.
 *
 * `rejected` counts citation failures only -- a discarded alias, and an
 * `added`/`removed` node left with zero surviving hunk citations (kept, but
 * counted as an unverified claim, not a dropped one). Every other cap below
 * (the per-tree node cap, the depth cap, a whitespace-only label, an
 * all-unchanged tree, a repeat-kind tree, a surviving tree past
 * `MAX_FLOW_TREES`) is silent, the same way `normalizeBriefStartHere`'s
 * five-file cap and an unmatched Start here path are silent.
 *
 * Patchdesk does not reshape a tree the model proposes -- a step nested
 * under itself, or repeated, is drawn as proposed; the guidance, not the
 * code, asks for a sensible graph -- because a real recursion or a call from
 * two places must stay visible.
 */

/** Whether one Flow step is new, gone, or the spine connecting the changed ones. */
export type BriefFlowChange = "added" | "removed" | "unchanged";

/**
 * What a Flow tree draws: a call tree of real function/method names, a
 * pseudocode control-flow sketch, or a component tree. The Brief keeps at
 * most one tree per kind (see `MAX_FLOW_TREES`).
 */
export type BriefFlowKind = "call_tree" | "control_flow" | "component";

/** One step of a Flow tree, already checked against the citation manifest. */
export type BriefFlowNode = {
  readonly label: string;
  readonly change: BriefFlowChange;
  readonly citations: ReadonlyArray<BriefCitation>;
  readonly children: ReadonlyArray<BriefFlowNode>;
};

/** One before/after tree: its kind, a title, and the steps that make it up. */
export type BriefFlowTree = {
  readonly kind: BriefFlowKind;
  readonly title: string;
  readonly nodes: ReadonlyArray<BriefFlowNode>;
};

/** The Flow block: up to `MAX_FLOW_TREES` before/after trees, at most one per kind. */
export type BriefFlow = {
  readonly trees: ReadonlyArray<BriefFlowTree>;
};

/** Kept trees per Brief, at most one per kind -- past this, Flow starts reading as the whole diff again. */
const MAX_FLOW_TREES = 3;
/** Kept node depth; a root node is depth 1. Enforced by the schema itself (see `flowNodeSchema`), so the matching check in `walkFlowNodes` is belt-and-braces. */
const MAX_FLOW_DEPTH = 3;
/** Pre-order nodes visited per tree before the rest of that tree is dropped. */
const MAX_FLOW_NODES_PER_TREE = 15;
/** Kept label length, after collapsing the raw label to one line -- call-tree labels are signatures like `validateManualDays(command, suggestion)`, longer than prose. */
const MAX_FLOW_LABEL_LENGTH = 120;
/** Raw label length the schema accepts, before normalization truncates the long ones. */
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
 * The raw shape of one Flow node before Patchdesk resolves its citations. The
 * optional fields carry an explicit `| undefined` because `v.optional`
 * infers a present-but-`undefined` value, which `exactOptionalPropertyTypes`
 * would otherwise reject on the `?:` modifier alone.
 *
 * This type stays recursive on purpose, even though the schema below is not:
 * a value bounded to `MAX_FLOW_DEPTH` levels (the schema's own guarantee)
 * still satisfies this wider, unbounded type, because `children` is optional
 * at every level -- so `walkFlowNodes` can walk any of the three concrete
 * depths through one shared parameter type.
 */
type BriefFlowNodeOutput = {
  readonly label: string;
  readonly change: BriefFlowChange;
  readonly citations?: ReadonlyArray<string> | undefined;
  readonly children?: ReadonlyArray<BriefFlowNodeOutput> | undefined;
};

/**
 * Builds one level of the Flow node schema. `childSchema` validates the
 * nodes one level deeper; passing `v.never()` forces `children` to be empty
 * at that level, because no value can ever satisfy `v.never()` and an empty
 * array has no element to check against it.
 *
 * Called three times below, nested by hand, this bounds the whole schema to
 * `MAX_FLOW_DEPTH` levels without a `v.lazy` self-reference: `safeParse`
 * against it cannot recurse past depth 3, and the schema carries no cycle a
 * JSON-schema conversion for a provider would have to represent as
 * `$ref`/`$defs`. A proposal nested past `MAX_FLOW_DEPTH` fails to parse at
 * all (the deepest level's `children` is provably empty), which rejects the
 * whole Brief as malformed -- see `normalizeBrief` in `brief.ts`. That is a
 * deliberate trade against keeping the rest of the Brief: the cap is stated
 * to the model (`insightOutputGuidance("brief")`), and `v.unknown()` -- the
 * only escape hatch with any precedent in this codebase
 * (`insight-record.ts`, `narrative-walkthrough.ts`) -- is used there only for
 * opaque passthrough values, never to validate a structural shape
 * permissively, so it is not a sound substitute for a real leaf schema here.
 */
function flowNodeSchema<ChildSchema extends v.GenericSchema>(
  childSchema: ChildSchema,
) {
  return v.strictObject({
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
      v.pipe(v.array(childSchema), v.maxLength(MAX_FLOW_CHILDREN_PER_NODE)),
    ),
  });
}

/** Depth 3, the deepest level `MAX_FLOW_DEPTH` allows: its `children` can only be empty. */
const briefFlowLeafOutputSchema = flowNodeSchema(v.never());
/** Depth 2: its `children` are depth-3 leaves. */
const briefFlowMidOutputSchema = flowNodeSchema(briefFlowLeafOutputSchema);
/** Depth 1, a tree's own root nodes: their `children` are depth-2 nodes. */
const briefFlowNodeOutputSchema = flowNodeSchema(briefFlowMidOutputSchema);

/**
 * The Flow keys a Brief child may return: up to `MAX_FLOW_TREES_INPUT`
 * before/after trees, each a title and its root nodes.
 */
export const briefFlowOutputSchema = v.optional(
  v.pipe(
    v.array(
      v.strictObject({
        kind: v.picklist(["call_tree", "control_flow", "component"]),
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
 * Walks one tree's proposed nodes in pre-order, applying, in this order: the
 * `MAX_FLOW_NODES_PER_TREE` cap, the `MAX_FLOW_DEPTH` cap, the label cap,
 * and finally -- for `added`/`removed` nodes only -- the rule that a changed
 * step left with no surviving hunk citation still keeps its place, but
 * counts toward `rejected` as an unverified claim. `unchanged` nodes need no
 * citation at all, but any they carry are still resolved so a non-hunk or
 * unknown alias still counts toward `rejected`.
 *
 * Only citation failures count toward `rejected`; the node cap, the depth
 * cap, and a whitespace-only label are silent.
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
    if (ctx.visited > MAX_FLOW_NODES_PER_TREE) continue;
    // Belt-and-braces: a schema-conformant `rawNodes` can never actually
    // reach depth 4, since the schema itself is bounded to `MAX_FLOW_DEPTH`.
    if (depth > MAX_FLOW_DEPTH) continue;

    // A whitespace-only label cannot fail `v.minLength(1)` on the raw
    // string, so it is checked here instead, after collapsing and
    // truncating it the way every other Brief label is capped.
    const label = singleLine(raw.label).slice(0, MAX_FLOW_LABEL_LENGTH);
    if (label === "") continue;

    const resolved = resolveFlowCitations(raw.citations ?? [], byAlias);
    ctx.rejected += resolved.rejected;

    if (raw.change !== "unchanged" && resolved.citations.length === 0) {
      ctx.rejected += 1;
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
 * Citations are best effort: an added or removed step keeps its place with
 * or without a hunk citation; a discarded alias or an uncited changed step
 * counts toward `rejected` so the Brief reads as partially verified, but the
 * tree is never cut for it. Only the diff can prove a step changed, so
 * description and commit aliases are still discarded.
 *
 * `rejected` counts citation failures only: a discarded alias (unknown,
 * repeated, or -- for a changed step -- resolved to a non-hunk kind), and an
 * `added`/`removed` node left with zero surviving hunk citations. Every
 * other cap here is silent, the same way `normalizeBriefStartHere`'s
 * five-file cap and an unmatched Start here path are silent: the per-tree
 * node cap, the `MAX_FLOW_DEPTH` cap (also enforced by the schema itself,
 * see `flowNodeSchema`), a whitespace-only label, a tree with no surviving
 * changed node, a second surviving tree of a kind already kept, and a
 * surviving tree past `MAX_FLOW_TREES`.
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

    if (!anyFlowNodeChanged(nodes)) continue;
    survivors.push({
      kind: rawTree.kind,
      title: normalizeFlowTitle(rawTree.title),
      nodes,
    });
  }

  // At most one surviving tree per kind, input order wins; then at most
  // `MAX_FLOW_TREES` overall. Both drops here are silent.
  const trees: Array<BriefFlowTree> = [];
  const keptKinds = new Set<BriefFlowKind>();
  for (const tree of survivors) {
    if (trees.length >= MAX_FLOW_TREES) continue;
    if (keptKinds.has(tree.kind)) continue;
    keptKinds.add(tree.kind);
    trees.push(tree);
  }

  return trees.length === 0
    ? { value: undefined, rejected }
    : { value: { trees }, rejected };
}

/**
 * Every hunk citation a kept Flow cites, walked node by node in tree order,
 * so `cutCitedHunks` can cut a preview for a Flow chip the same way it does
 * for any other cited hunk.
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
