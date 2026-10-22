import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import {
  insightIndexNodeCodec,
  type InsightIndexElement,
  type InsightBlobIndexNode,
} from "#src/domain/insight-artifact-index";
import type {
  InsightArtifactIndexDescriptor,
  InsightArtifactReference,
} from "#src/domain/insight-artifact-scalars";
import { err, ok, type Result } from "#src/domain/result";
import type { InsightArtifactStore } from "./insight-artifact-store";
import type { StorageFailure } from "./json-file";

type Entry = Extract<InsightBlobIndexNode, { tag: "leaf" }>["entries"][number];
type Child = Extract<
  InsightBlobIndexNode,
  { tag: "branch" }
>["children"][number];

// Sixteen preserves existing small metadata leaves and bounds every encoded wrapper below 16 KiB.
const nodeEntries = 16;

/** Append-only typed index construction; only one bounded node per level is retained. */
export class InsightIndexBuilder {
  private entries: Entry[] = [];
  private readonly levels: Child[][] = [];
  private count = 0;
  private closed = false;

  /** The artifact store owns canonical encoding and durable no-overwrite installation. */
  constructor(
    private readonly artifacts: Pick<InsightArtifactStore, "writeObject">,
    private readonly profileId: WorkspaceProfileId,
    private readonly reviewId: ReviewId,
    private readonly element: InsightIndexElement,
  ) {}

  /** Adds exactly the next zero-based ordinal; failure closes this builder. */
  async append(
    value: InsightArtifactReference,
  ): Promise<Result<void, StorageFailure>> {
    if (this.closed || !Number.isSafeInteger(this.count + 1))
      return invalidIndex();
    if (this.entries.length === nodeEntries) {
      const flushed = await this.flushLeaf();
      if (flushed._tag === "err") return flushed;
    }
    this.entries.push({ key: String(this.count).padStart(16, "0"), value });
    this.count += 1;
    return ok(undefined);
  }

  /** Finishes once, collapsing single pending roots without creating unary branches. */
  async finish(): Promise<
    Result<InsightArtifactIndexDescriptor, StorageFailure>
  > {
    if (this.closed) return invalidIndex();
    this.closed = true;
    if (this.levels.length === 0) {
      const root = await this.writeNode({ tag: "leaf", entries: this.entries });
      return root._tag === "err"
        ? root
        : ok({ root: root.value, count: this.count });
    }
    if (this.entries.length > 0) {
      const flushed = await this.flushLeaf();
      if (flushed._tag === "err") return flushed;
    }
    for (let level = 0; level < this.levels.length; level += 1) {
      const children = this.levels[level];
      if (children === undefined || children.length === 0) continue;
      const only = children[0];
      if (only === undefined) return invalidIndex();
      const combined =
        children.length === 1 ? ok(only) : await this.writeBranch(children);
      if (combined._tag === "err") return combined;
      this.levels[level] = [];
      if (level === this.levels.length - 1)
        return ok({ root: combined.value.root, count: this.count });
      const pushed = await this.pushChild(level + 1, combined.value);
      if (pushed._tag === "err") return pushed;
    }
    return invalidIndex();
  }

  private async flushLeaf(): Promise<Result<void, StorageFailure>> {
    const first = this.entries[0];
    const last = this.entries.at(-1);
    if (first === undefined || last === undefined) return invalidIndex();
    const root = await this.writeNode({ tag: "leaf", entries: this.entries });
    if (root._tag === "err") return root;
    const child = {
      first: first.key,
      last: last.key,
      count: this.entries.length,
      root: root.value,
    };
    this.entries = [];
    return this.pushChild(0, child);
  }

  private async pushChild(
    level: number,
    child: Child,
  ): Promise<Result<void, StorageFailure>> {
    const children = this.levels[level] ?? [];
    this.levels[level] = children;
    children.push(child);
    if (children.length <= nodeEntries) return ok(undefined);
    // Keep two children pending so a final remainder never requires a unary branch.
    const branch = await this.writeBranch(children.splice(0, nodeEntries - 1));
    if (branch._tag === "err") return branch;
    return this.pushChild(level + 1, branch.value);
  }

  private async writeBranch(
    children: Child[],
  ): Promise<Result<Child, StorageFailure>> {
    const first = children[0];
    const last = children.at(-1);
    if (children.length < 2 || first === undefined || last === undefined)
      return invalidIndex();
    let count = 0;
    for (const child of children) {
      const nextCount = count + child.count;
      if (!Number.isSafeInteger(nextCount)) return invalidIndex();
      count = nextCount;
    }
    const root = await this.writeNode({ tag: "branch", children });
    return root._tag === "err"
      ? root
      : ok({ first: first.first, last: last.last, count, root: root.value });
  }

  private async writeNode(
    node: InsightBlobIndexNode,
  ): Promise<Result<InsightArtifactReference, StorageFailure>> {
    const result = await this.artifacts.writeObject(
      this.profileId,
      this.reviewId,
      insightIndexNodeCodec(this.element),
      node,
    );
    if (result._tag === "err") this.closed = true;
    return result;
  }
}

function invalidIndex(): Result<never, StorageFailure> {
  return err({
    _tag: "StorageFailure",
    operation: "write",
    reason: "invalid_stored_value",
  });
}
