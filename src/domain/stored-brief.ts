import * as v from "valibot";

import {
  BRIEF_ALIAS_SYNTAX,
  type BriefCitation,
  type BriefDescriptionDrift,
  type BriefError,
  type NormalizedBrief,
} from "./brief";
import type {
  BriefFlow,
  BriefFlowChange,
  BriefFlowNode,
  BriefFlowTree,
} from "./brief-flow";
import type { BriefOwnership } from "./brief-ownership";
import type { BriefReach } from "./brief-reach";
import type { BriefStartHere } from "./brief-start-here";
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
  contract: v.optional(
    v.strictObject({
      path: v.pipe(v.string(), v.minLength(1)),
      header: v.string(),
      raw: v.pipe(v.string(), v.minLength(1)),
      caption: v.pipe(v.string(), v.minLength(1)),
    }),
  ),
});
const storedStartHereSchema = v.strictObject({
  lead: v.pipe(v.string(), v.minLength(1)),
  order: v.pipe(
    v.array(
      v.strictObject({
        path: v.pipe(v.string(), v.minLength(1)),
        why: v.optional(v.pipe(v.string(), v.minLength(1))),
      }),
    ),
    v.minLength(1),
  ),
});
/** One stored Flow node, recursive at `children` the way `StoredFlowNode` is below. */
type StoredFlowNode = {
  readonly label: string;
  readonly change: BriefFlowChange;
  readonly citations: ReadonlyArray<StoredBriefCitation>;
  readonly children: ReadonlyArray<StoredFlowNode>;
};

/**
 * One stored Flow node's schema. Recursive via `v.lazy` at `children`, the
 * same way `briefFlowNodeOutputSchema` in `brief-flow.ts` refers to itself.
 */
const storedFlowNodeSchema: v.GenericSchema<StoredFlowNode> = v.strictObject({
  label: v.pipe(v.string(), v.minLength(1)),
  change: v.picklist(["added", "removed", "unchanged"]),
  citations: v.array(storedCitationSchema),
  children: v.array(v.lazy(() => storedFlowNodeSchema)),
});
const storedFlowTreeSchema = v.strictObject({
  title: v.pipe(v.string(), v.minLength(1)),
  nodes: v.array(storedFlowNodeSchema),
});
const storedFlowSchema = v.strictObject({
  trees: v.pipe(v.array(storedFlowTreeSchema), v.minLength(1)),
});
const storedReachSchema = v.strictObject({
  symbols: v.array(
    v.strictObject({
      name: v.pipe(v.string(), v.minLength(1)),
      outsideCallerFiles: v.pipe(v.number(), v.integer(), v.minValue(0)),
      outsidePaths: v.array(v.pipe(v.string(), v.minLength(1))),
      insidePR: v.boolean(),
    }),
  ),
  surfaces: v.array(
    v.strictObject({
      surface: v.pipe(v.string(), v.minLength(1)),
      path: v.optional(v.pipe(v.string(), v.minLength(1))),
    }),
  ),
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
  goal: v.pipe(
    v.array(
      v.strictObject({
        text: v.pipe(v.string(), v.minLength(1)),
        citations: v.pipe(v.array(storedCitationSchema), v.minLength(1)),
      }),
    ),
    v.minLength(1),
  ),
  assumptions: v.array(
    v.strictObject({ text: v.string(), demoted: v.boolean() }),
  ),
  /** Absent on every Brief retained before the description-vs-diff block existed. */
  descriptionDrift: v.optional(
    v.strictObject({
      claimed: v.array(
        v.strictObject({
          quote: v.pipe(v.string(), v.minLength(1)),
          note: v.string(),
          citations: v.pipe(v.array(storedCitationSchema), v.minLength(1)),
        }),
      ),
      undescribed: v.array(
        v.strictObject({
          text: v.pipe(v.string(), v.minLength(1)),
          citations: v.pipe(v.array(storedCitationSchema), v.minLength(1)),
        }),
      ),
    }),
  ),
  /** Absent on every Brief retained before the Ownership block existed. */
  ownership: v.optional(storedOwnershipSchema),
  /** Absent on a Brief retained before the Start here block existed, and whenever no proposed path was a changed file. */
  startHere: v.optional(storedStartHereSchema),
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
  const goal: Array<NormalizedBrief["goal"][number]> = [];
  for (const item of parsed.output.goal) {
    const citations = parseStoredCitations(item.citations);
    if (citations === undefined) return malformedBrief();
    goal.push({ text: item.text, citations });
  }
  const drift = parsed.output.descriptionDrift;
  const claimed: Array<BriefDescriptionDrift["claimed"][number]> = [];
  const undescribed: Array<BriefDescriptionDrift["undescribed"][number]> = [];
  for (const item of drift?.claimed ?? []) {
    const citations = parseStoredCitations(item.citations);
    if (citations === undefined) return malformedBrief();
    claimed.push({ quote: item.quote, note: item.note, citations });
  }
  for (const item of drift?.undescribed ?? []) {
    const citations = parseStoredCitations(item.citations);
    if (citations === undefined) return malformedBrief();
    undescribed.push({ text: item.text, citations });
  }
  let flow: BriefFlow | undefined;
  if (parsed.output.flow !== undefined) {
    const trees: Array<BriefFlowTree> = [];
    for (const tree of parsed.output.flow.trees) {
      const parsedTree = storedFlowTree(tree);
      if (parsedTree === undefined) return malformedBrief();
      trees.push(parsedTree);
    }
    flow = { trees };
  }
  return ok({
    snapshot: {
      profileId: profileId.value,
      sessionId: sessionId.value,
      headSha: headSha.value,
      patchHash: patchHash.value,
    },
    citationStatus: parsed.output.citationStatus,
    goal,
    assumptions: parsed.output.assumptions,
    ...definedProps({
      descriptionDrift:
        drift === undefined ? undefined : { claimed, undescribed },
      ownership: storedOwnership(parsed.output.ownership),
      startHere: storedStartHere(parsed.output.startHere),
      reach: storedReach(parsed.output.reach),
      reachUnavailable: parsed.output.reachUnavailable,
      citedHunks: parsed.output.citedHunks,
      flow,
    }),
  });
}

/**
 * Rebuilds the Reach block. Only `surface.path` needs rewriting: valibot infers
 * an optional key as `string | undefined`, which an `exactOptionalPropertyTypes`
 * target reads as a present key holding `undefined`.
 */
function storedReach(
  stored: v.InferOutput<typeof storedReachSchema> | undefined,
): BriefReach | undefined {
  if (stored === undefined) return undefined;
  return {
    ...stored,
    surfaces: stored.surfaces.map((entry) => ({
      surface: entry.surface,
      ...definedProps({ path: entry.path }),
    })),
  };
}

/**
 * Rebuilds the Start here block. Only `why` needs rewriting, for the same
 * `exactOptionalPropertyTypes` reason `storedReach` rewrites `surface.path`.
 */
function storedStartHere(
  stored: v.InferOutput<typeof storedStartHereSchema> | undefined,
): BriefStartHere | undefined {
  if (stored === undefined) return undefined;
  return {
    lead: stored.lead,
    order: stored.order.map((entry) => ({
      path: entry.path,
      ...definedProps({ why: entry.why }),
    })),
  };
}

/** Rebuilds the Ownership block; `undefined` is a Brief retained before it existed. */
function storedOwnership(
  stored: v.InferOutput<typeof storedOwnershipSchema> | undefined,
): BriefOwnership | undefined {
  if (stored === undefined) return undefined;
  return {
    files: stored.files,
    notes: stored.notes,
    ...definedProps({ contract: stored.contract }),
  };
}

/**
 * Rebuilds one Flow tree from storage, re-parsing every node's citations;
 * `undefined` means one of them no longer parses, the same failure
 * `parseStoredCitations` reports for a goal or drift item.
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
  return { title: stored.title, nodes };
}

/** Rebuilds one Flow node from storage; `undefined` means a citation path no longer parses. */
function storedFlowNode(
  stored: v.InferOutput<typeof storedFlowNodeSchema>,
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
