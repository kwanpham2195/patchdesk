import * as v from "valibot";

import {
  BRIEF_ALIAS_SYNTAX,
  type BriefCitation,
  type BriefError,
  type NormalizedBrief,
} from "./brief";
import type { BriefFlow, BriefFlowNode, BriefFlowTree } from "./brief-flow";
import type { BriefMoves } from "./brief-moves";
import { BRIEF_SIGNAL_KINDS, type BriefSignal } from "./brief-signals";
import type { BriefOwnership } from "./brief-ownership";
import type { BriefReach } from "./brief-reach";
import { definedProps } from "./defined-props";
import {
  parseContentHash,
  parseGitSha,
  parseRepoRelativePath,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "./ids";
import { err, ok, type Result } from "./result";

const storedCitationSchema = v.strictObject({
  alias: v.pipe(v.string(), v.regex(BRIEF_ALIAS_SYNTAX)),
  kind: v.picklist(["hunk", "description", "commit"]),
  label: v.string(),
  path: v.optional(v.string()),
});
const storedLineCountSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const storedOwnershipSchema = v.strictObject({
  files: v.array(
    v.strictObject({
      path: v.pipe(v.string(), v.minLength(1)),
      status: v.picklist(["added", "removed", "modified", "renamed"]),
      additions: storedLineCountSchema,
      deletions: storedLineCountSchema,
    }),
  ),
  notes: v.array(
    v.strictObject({
      path: v.pipe(v.string(), v.minLength(1)),
      note: v.pipe(v.string(), v.minLength(1)),
    }),
  ),
  /** Written by Briefs retained before this release; read and ignored. Delete after the next release (ADR 0040 drops the Shape contract hunk). */
  contract: v.optional(v.unknown()),
});
const storedMovesSchema = v.strictObject({
  rows: v.array(
    v.strictObject({
      from: v.string(),
      to: v.string(),
      files: storedLineCountSchema,
      editedFiles: storedLineCountSchema,
      names: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
  ),
  hiddenRows: storedLineCountSchema,
  movedFiles: storedLineCountSchema,
  referenceUpdates: v.optional(storedLineCountSchema),
  leads: v.boolean(),
});
const storedSignalsSchema = v.array(
  v.strictObject({
    kind: v.picklist(BRIEF_SIGNAL_KINDS),
    count: storedLineCountSchema,
    paths: v.array(v.pipe(v.string(), v.minLength(1))),
    detail: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
);
/**
 * Builds one level of the stored Flow node schema, the same way
 * `flowNodeSchema` in `brief-flow.ts` does: `childSchema` validates one level
 * deeper, and passing `v.never()` at the deepest level forces `children` to
 * be empty there, bounding the schema to three levels without a `v.lazy`
 * self-reference.
 */
function storedFlowNodeSchema<ChildSchema extends v.GenericSchema>(
  childSchema: ChildSchema,
) {
  return v.strictObject({
    label: v.pipe(v.string(), v.minLength(1)),
    change: v.picklist(["added", "removed", "unchanged"]),
    citations: v.array(storedCitationSchema),
    children: v.array(childSchema),
  });
}

/** Depth 3, the deepest level: its `children` can only be empty. */
const storedFlowLeafSchema = storedFlowNodeSchema(v.never());
/** Depth 2: its `children` are depth-3 leaves. */
const storedFlowMidSchema = storedFlowNodeSchema(storedFlowLeafSchema);
/** Depth 1, a tree's own root nodes: their `children` are depth-2 nodes. */
const storedFlowRootSchema = storedFlowNodeSchema(storedFlowMidSchema);
const storedFlowTreeSchema = v.strictObject({
  kind: v.picklist([
    "call_tree",
    "control_flow",
    "component",
    "state",
    "contract",
  ]),
  title: v.pipe(v.string(), v.minLength(1)),
  nodes: v.array(storedFlowRootSchema),
});
const storedFlowSchema = v.strictObject({
  trees: v.pipe(v.array(storedFlowTreeSchema), v.minLength(1)),
  omittedTrees: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
const storedReachMentionSchema = v.strictObject({
  path: v.pipe(v.string(), v.minLength(1)),
  line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  enclosing: v.optional(v.pipe(v.string(), v.minLength(1))),
  kind: v.picklist(["call", "type", "import", "other"]),
});
// Briefs retained before mention sites existed lack both; the reader then draws files.
const storedReachMentionFields = {
  mentions: v.optional(v.array(storedReachMentionSchema)),
  mentionCount: v.optional(storedLineCountSchema),
};
const storedReachSchema = v.strictObject({
  symbols: v.array(
    v.strictObject({
      name: v.pipe(v.string(), v.minLength(1)),
      outsideCallerFiles: v.pipe(v.number(), v.integer(), v.minValue(0)),
      outsidePaths: v.array(v.pipe(v.string(), v.minLength(1))),
      insidePR: v.boolean(),
      // Briefs retained before the Blast radius view lack it; they read as `changed` so no name is hidden.
      status: v.optional(v.picklist(["new", "changed"])),
      ...storedReachMentionFields,
    }),
  ),
  /** Written by Briefs retained before Signals replaced Surfaces crossed (#721); read and ignored. */
  surfaces: v.optional(v.unknown()),
  untested: v.array(
    v.strictObject({
      path: v.pipe(v.string(), v.minLength(1)),
      reason: v.literal("no_test_in_pr"),
    }),
  ),
  removedStillReferenced: v.array(
    v.strictObject({
      name: v.pipe(v.string(), v.minLength(1)),
      paths: v.array(v.pipe(v.string(), v.minLength(1))),
      ...storedReachMentionFields,
    }),
  ),
  method: v.literal("text_match"),
  hop: v.literal(1),
});
const storedBriefSchema = v.strictObject({
  snapshot: v.strictObject({
    profileId: v.string(),
    sessionId: v.string(),
    headSha: v.string(),
    patchHash: v.string(),
  }),
  citationStatus: v.picklist(["verified", "partially_verified"]),
  /** Written by Briefs retained up to 0.1.3; read and ignored. Delete after the next release (ADR 0040). */
  goal: v.optional(v.unknown()),
  /** Written by Briefs retained up to 0.1.3; read and ignored. Delete after the next release (ADR 0040). */
  assumptions: v.optional(v.unknown()),
  /** Written by Briefs retained up to 0.1.3; read and ignored. Delete after the next release (ADR 0040). */
  descriptionDrift: v.optional(v.unknown()),
  /** Absent on every Brief retained before the Ownership block existed. */
  ownership: v.optional(storedOwnershipSchema),
  /** Absent on a Brief retained before the Moves block existed, and whenever the patch moved no directory. */
  moves: v.optional(storedMovesSchema),
  /** Absent on a Brief retained before the Signals block existed. */
  signals: v.optional(storedSignalsSchema),
  /** Written by Briefs retained before Start here was removed (#716); read and ignored. */
  startHere: v.optional(v.unknown()),
  /** Absent on a Brief retained before the Reach block existed, and whenever the search could not answer. */
  reach: v.optional(storedReachSchema),
  reachUnavailable: v.optional(
    v.picklist([
      "worktree_unavailable",
      "head_mismatch",
      "search_failed",
      "timed_out",
    ]),
  ),
  /** Absent on a Brief retained before this existed, and whenever no cited hunk could be cut. */
  citedHunks: v.optional(
    v.record(
      v.pipe(v.string(), v.regex(BRIEF_ALIAS_SYNTAX)),
      v.pipe(v.string(), v.minLength(1)),
    ),
  ),
  /** Absent on a Brief retained before the Flow block existed, and whenever no tree survived. */
  flow: v.optional(storedFlowSchema),
});

type StoredBriefCitation = v.InferOutput<typeof storedCitationSchema>;

/**
 * Parses one Brief that storage already holds. A retained Brief carries its own
 * resolved citation labels, so reading it back needs no patch bytes -- unlike a
 * Walkthrough, which must be renormalized against its session's patch.
 *
 * A stored `goal`, `assumptions`, or `descriptionDrift` key -- written by a
 * Brief retained up to 0.1.3 -- is read by the schema above only to let the
 * record parse; nothing here draws a value from it (ADR 0040).
 */
export function parseStoredBrief(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the stored Brief's read boundary; the very next statement runs `safeParse(storedBriefSchema, input)` against it before anything else touches it.
  input: unknown,
): Result<NormalizedBrief, BriefError> {
  const parsed = v.safeParse(storedBriefSchema, input);
  if (!parsed.success) return malformedBrief();
  const profileId = parseWorkspaceProfileId(parsed.output.snapshot.profileId);
  const sessionId = parseReviewSessionId(parsed.output.snapshot.sessionId);
  const headSha = parseGitSha(parsed.output.snapshot.headSha);
  const patchHash = parseContentHash(parsed.output.snapshot.patchHash);
  if (
    profileId._tag === "err" ||
    sessionId._tag === "err" ||
    headSha._tag === "err" ||
    patchHash._tag === "err"
  )
    return malformedBrief();
  let flow: BriefFlow | undefined;
  if (parsed.output.flow !== undefined) {
    const trees: Array<BriefFlowTree> = [];
    for (const tree of parsed.output.flow.trees) {
      const parsedTree = storedFlowTree(tree);
      if (parsedTree === undefined) return malformedBrief();
      trees.push(parsedTree);
    }
    flow = {
      trees,
      ...definedProps({ omittedTrees: parsed.output.flow.omittedTrees }),
    };
  }
  return ok({
    snapshot: {
      profileId: profileId.value,
      sessionId: sessionId.value,
      headSha: headSha.value,
      patchHash: patchHash.value,
    },
    citationStatus: parsed.output.citationStatus,
    ...definedProps({
      ownership: storedOwnership(parsed.output.ownership),
      moves: storedMoves(parsed.output.moves),
      signals: storedSignals(parsed.output.signals),
      reach: storedReach(parsed.output.reach),
      reachUnavailable: parsed.output.reachUnavailable,
      citedHunks: parsed.output.citedHunks,
      flow,
    }),
  });
}

/**
 * Rebuilds the Reach block. Mention sites are rebuilt because valibot infers
 * an optional key as `string | undefined`, which an `exactOptionalPropertyTypes`
 * target reads as a present key holding `undefined`; a missing symbol
 * `status` reads as `changed`, and a legacy `surfaces` key is dropped.
 */
function storedReach(
  stored: v.InferOutput<typeof storedReachSchema> | undefined,
): BriefReach | undefined {
  if (stored === undefined) return undefined;
  const { surfaces: _legacySurfaces, ...reach } = stored;
  return {
    ...reach,
    symbols: stored.symbols.map((symbol) => ({
      name: symbol.name,
      outsideCallerFiles: symbol.outsideCallerFiles,
      outsidePaths: symbol.outsidePaths,
      insidePR: symbol.insidePR,
      status: symbol.status ?? "changed",
      ...storedMentions(symbol),
    })),
    removedStillReferenced: stored.removedStillReferenced.map((item) => ({
      name: item.name,
      paths: item.paths,
      ...storedMentions(item),
    })),
  };
}

/** Rebuilds a name's mention sites, dropping the keys a legacy Brief never wrote. */
function storedMentions(stored: {
  readonly mentions?:
    | ReadonlyArray<v.InferOutput<typeof storedReachMentionSchema>>
    | undefined;
  readonly mentionCount?: number | undefined;
}) {
  return definedProps({
    mentions: stored.mentions?.map((mention) => ({
      path: mention.path,
      line: mention.line,
      kind: mention.kind,
      ...definedProps({ enclosing: mention.enclosing }),
    })),
    mentionCount: stored.mentionCount,
  });
}

/** Rebuilds the Signals rows; `undefined` is a Brief retained before they existed. */
function storedSignals(
  stored: v.InferOutput<typeof storedSignalsSchema> | undefined,
): ReadonlyArray<BriefSignal> | undefined {
  return stored?.map(({ detail, ...signal }) => ({
    ...signal,
    ...definedProps({ detail }),
  }));
}

/** Rebuilds the Moves block; `referenceUpdates` is absent on a Brief retained before it was counted. */
function storedMoves(
  stored: v.InferOutput<typeof storedMovesSchema> | undefined,
): BriefMoves | undefined {
  if (stored === undefined) return undefined;
  const { referenceUpdates, ...moves } = stored;
  return { ...moves, ...definedProps({ referenceUpdates }) };
}

/** Rebuilds the Ownership block; `undefined` is a Brief retained before it existed. */
function storedOwnership(
  stored: v.InferOutput<typeof storedOwnershipSchema> | undefined,
): BriefOwnership | undefined {
  if (stored === undefined) return undefined;
  return { files: stored.files, notes: stored.notes };
}

/**
 * Rebuilds one Flow tree from storage, re-parsing every node's citations;
 * `undefined` means one of them no longer parses.
 */
function storedFlowTree(
  stored: v.InferOutput<typeof storedFlowTreeSchema>,
): BriefFlowTree | undefined {
  const nodes: Array<BriefFlowNode> = [];
  for (const node of stored.nodes) {
    const parsed = storedFlowNode(node);
    if (parsed === undefined) return undefined;
    nodes.push(parsed);
  }
  return { kind: stored.kind, title: stored.title, nodes };
}

/** Rebuilds one Flow node from storage; `undefined` means a citation path no longer parses. */
function storedFlowNode(
  stored: v.InferOutput<typeof storedFlowRootSchema>,
): BriefFlowNode | undefined {
  const citations = parseStoredCitations(stored.citations);
  if (citations === undefined) return undefined;
  const children: Array<BriefFlowNode> = [];
  for (const child of stored.children) {
    const parsedChild = storedFlowNode(child);
    if (parsedChild === undefined) return undefined;
    children.push(parsedChild);
  }
  return { label: stored.label, change: stored.change, citations, children };
}

/** Re-parses one stored citation list; `undefined` means a path no longer parses. */
function parseStoredCitations(
  stored: ReadonlyArray<StoredBriefCitation>,
): ReadonlyArray<BriefCitation> | undefined {
  const citations: Array<BriefCitation> = [];
  for (const citation of stored) {
    const path =
      citation.path === undefined
        ? undefined
        : parseRepoRelativePath(citation.path);
    if (path?._tag === "err") return undefined;
    citations.push({
      alias: citation.alias,
      kind: citation.kind,
      label: citation.label,
      ...definedProps({ path: path?.value }),
    });
  }
  return citations;
}

/** Every way a stored Brief can fail to read is the same failure: it is not one. */
function malformedBrief(): Result<never, BriefError> {
  return err({ _tag: "InvalidBrief", reason: "malformed" });
}
