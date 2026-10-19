import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import {
  insightIndexNodeCodec,
  type InsightBlobIndexNode,
  type InsightIndexElement,
} from "#src/domain/insight-artifact-index";
import type {
  InsightArtifactIndexDescriptor,
  InsightArtifactReference,
} from "#src/domain/insight-artifact-scalars";
import { err, ok, type Result } from "#src/domain/result";
import type { InsightArtifactStore } from "./insight-artifact-store";
import type { StorageFailure } from "./json-file";

// Nodes stay far under the 16 KiB wrapper bound even at the largest reference encoding.
const MAX_LEAF_ENTRIES = 64;
const MAX_BRANCH_CHILDREN = 32;
const MAX_INDEX_DEPTH = 16;

/** Where an index lives; ordinal keys are zero-padded to 16 digits, the contract's default key. */
export type InsightIndexScope = {
  readonly artifacts: InsightArtifactStore;
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly element: InsightIndexElement;
};

type Child = Extract<
  InsightBlobIndexNode,
  { tag: "branch" }
>["children"][number];

/** Stages the empty root leaf of an Index<X>. */
export async function writeEmptyInsightIndex(
  scope: InsightIndexScope,
): Promise<Result<InsightArtifactIndexDescriptor, StorageFailure>> {
  const root = await writeNode(scope, { tag: "leaf", entries: [] });
  return root._tag === "err" ? root : ok({ root: root.value, count: 0 });
}

/** Stages a copy of `index` with one more entry at an ordinal greater than every present key; earlier nodes are reused. */
export async function appendInsightIndexEntry(
  scope: InsightIndexScope,
  index: InsightArtifactIndexDescriptor,
  ordinal: number,
  value: InsightArtifactReference,
): Promise<Result<InsightArtifactIndexDescriptor, StorageFailure>> {
  const appended = await appendToNode(
    scope,
    index.root,
    ordinalKey(ordinal),
    value,
    0,
  );
  if (appended._tag === "err") return appended;
  const count = appended.value.reduce((sum, child) => sum + child.count, 0);
  if (count !== index.count + 1) return invalidIndex("write");
  const [only, second] = appended.value;
  if (only === undefined) return invalidIndex("write");
  if (second === undefined) return ok({ root: only.root, count });
  const root = await writeNode(scope, {
    tag: "branch",
    children: [only, second],
  });
  return root._tag === "err" ? root : ok({ root: root.value, count });
}

/** Finds the value stored under `ordinal`, or undefined when no entry has that key. */
export async function findInsightIndexEntry(
  scope: InsightIndexScope,
  index: InsightArtifactIndexDescriptor,
  ordinal: number,
): Promise<Result<InsightArtifactReference | undefined, StorageFailure>> {
  const key = ordinalKey(ordinal);
  let reference = index.root;
  for (let depth = 0; depth < MAX_INDEX_DEPTH; depth += 1) {
    const node = await readNode(scope, reference);
    if (node._tag === "err") return node;
    if (node.value.tag === "leaf")
      return ok(node.value.entries.find((entry) => entry.key === key)?.value);
    const child = node.value.children.find(
      (candidate) => candidate.first <= key && key <= candidate.last,
    );
    if (child === undefined) return ok(undefined);
    reference = child.root;
  }
  return invalidIndex("read");
}

async function appendToNode(
  scope: InsightIndexScope,
  reference: InsightArtifactReference,
  key: string,
  value: InsightArtifactReference,
  depth: number,
): Promise<Result<Child[], StorageFailure>> {
  if (depth >= MAX_INDEX_DEPTH) return invalidIndex("write");
  const node = await readNode(scope, reference);
  if (node._tag === "err") return err({ ...node.error, operation: "write" });
  if (node.value.tag === "leaf") {
    const entries = node.value.entries;
    const last = entries.at(-1);
    if (last !== undefined && key <= last.key) return invalidIndex("write");
    const fresh: Child[] = [];
    let base = entries;
    if (entries.length >= MAX_LEAF_ENTRIES && last !== undefined) {
      fresh.push({
        first: entries[0]?.key ?? last.key,
        last: last.key,
        count: entries.length,
        root: reference,
      });
      base = [];
    }
    const next = [...base, { key, value }];
    const written = await writeNode(scope, { tag: "leaf", entries: next });
    if (written._tag === "err") return written;
    fresh.push({
      first: next[0]?.key ?? key,
      last: key,
      count: next.length,
      root: written.value,
    });
    return ok(fresh);
  }
  const children = node.value.children;
  const tail = children.at(-1);
  if (tail === undefined || key <= tail.last) return invalidIndex("write");
  const appended = await appendToNode(scope, tail.root, key, value, depth + 1);
  if (appended._tag === "err") return appended;
  const merged = [...children.slice(0, -1), ...appended.value];
  if (merged.length <= MAX_BRANCH_CHILDREN) return writeBranch(scope, merged);
  // A branch needs at least two children, so the overflow moves the last two into a new sibling.
  const [left, right] = await Promise.all([
    writeBranch(scope, merged.slice(0, -2)),
    writeBranch(scope, merged.slice(-2)),
  ]);
  if (left._tag === "err") return left;
  if (right._tag === "err") return right;
  return ok([...left.value, ...right.value]);
}

async function writeBranch(
  scope: InsightIndexScope,
  children: Child[],
): Promise<Result<Child[], StorageFailure>> {
  const first = children[0];
  const last = children.at(-1);
  if (first === undefined || last === undefined) return invalidIndex("write");
  const written = await writeNode(scope, { tag: "branch", children });
  return written._tag === "err"
    ? written
    : ok([
        {
          first: first.first,
          last: last.last,
          count: children.reduce((sum, child) => sum + child.count, 0),
          root: written.value,
        },
      ]);
}

function readNode(
  scope: InsightIndexScope,
  reference: InsightArtifactReference,
): Promise<Result<InsightBlobIndexNode, StorageFailure>> {
  return scope.artifacts.readObject(
    scope.profileId,
    scope.reviewId,
    insightIndexNodeCodec(scope.element),
    reference,
  );
}

function writeNode(
  scope: InsightIndexScope,
  node: InsightBlobIndexNode,
): Promise<Result<InsightArtifactReference, StorageFailure>> {
  return scope.artifacts.writeObject(
    scope.profileId,
    scope.reviewId,
    insightIndexNodeCodec(scope.element),
    node,
  );
}

function ordinalKey(ordinal: number): string {
  return String(ordinal).padStart(16, "0");
}

function invalidIndex(
  operation: "read" | "write",
): Result<never, StorageFailure> {
  return err({
    _tag: "StorageFailure",
    operation,
    reason: "invalid_stored_value",
  });
}
