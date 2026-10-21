import { createHash } from "node:crypto";

import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import {
  insightBlobBlockCodec,
  insightIndexNodeCodec,
  type InsightBlobIndexNode,
  type InsightIndexElement,
} from "#src/domain/insight-artifact-index";
import type {
  InsightArtifactIndexDescriptor,
  InsightArtifactReference,
  InsightTextRootDescriptor,
} from "#src/domain/insight-artifact-scalars";
import { err, ok, type Result } from "#src/domain/result";
import {
  appendInsightIndexEntry,
  writeEmptyInsightIndex,
} from "./insight-index-append";
import type { InsightArtifactStore } from "./insight-artifact-store";
import type { StorageFailure } from "./json-file";

const MAX_INDEX_DEPTH = 16;

/** A position inside a TextRoot: block ordinal and UTF-16 unit offset within that block. */
export type GuideTextPosition = {
  readonly block: number;
  readonly unit: number;
};

/** One index entry: its ordinal key and the object it names. */
export type GuideIndexEntry = {
  readonly key: string;
  readonly value: InsightArtifactReference;
};

/**
 * Bounded traversal of typed indexes and TextRoots for the Guide graph. Every read verifies the object hash through
 * the artifact store and checks node counts against the parent's claim; the traversal retains no more than one
 * requested window, so a root that names thousands of entries or many blocks is read page by page, not whole.
 */
export class GuideResultStore {
  constructor(
    private readonly artifacts: InsightArtifactStore,
    private readonly profileId: WorkspaceProfileId,
    private readonly reviewId: ReviewId,
  ) {}

  emptyIndex(
    element: InsightIndexElement,
  ): Promise<Result<InsightArtifactIndexDescriptor, StorageFailure>> {
    return writeEmptyInsightIndex(this.scope(element));
  }

  appendIndex(
    element: InsightIndexElement,
    index: InsightArtifactIndexDescriptor,
    ordinal: number,
    value: InsightArtifactReference,
  ): Promise<Result<InsightArtifactIndexDescriptor, StorageFailure>> {
    return appendInsightIndexEntry(this.scope(element), index, ordinal, value);
  }

  /** Entries at zero-based positions `[position, position + limit)`, in key order. */
  async readIndex(
    element: InsightIndexElement,
    index: InsightArtifactIndexDescriptor,
    position: number,
    limit: number,
  ): Promise<Result<ReadonlyArray<GuideIndexEntry>, StorageFailure>> {
    if (position < 0 || position > index.count || limit < 0) return invalid();
    const out: GuideIndexEntry[] = [];
    const walked = await this.walk(
      element,
      index.root,
      index.count,
      position,
      limit,
      out,
      0,
    );
    if (walked._tag === "err") return walked;
    return out.length === Math.min(limit, index.count - position)
      ? ok(out)
      : invalid();
  }

  /** Every entry of an index whose count the caller already bounded. */
  readWholeIndex(
    element: InsightIndexElement,
    index: InsightArtifactIndexDescriptor,
  ): Promise<Result<ReadonlyArray<GuideIndexEntry>, StorageFailure>> {
    return this.readIndex(element, index, 0, index.count);
  }

  private async walk(
    element: InsightIndexElement,
    reference: InsightArtifactReference,
    expected: number,
    skip: number,
    take: number,
    out: GuideIndexEntry[],
    depth: number,
  ): Promise<Result<void, StorageFailure>> {
    if (depth >= MAX_INDEX_DEPTH) return invalid();
    const startLength = out.length;
    const wanted = Math.min(take, expected - skip);
    const node = await this.artifacts.readObject(
      this.profileId,
      this.reviewId,
      insightIndexNodeCodec(element),
      reference,
    );
    if (node._tag === "err") return node;
    const value: InsightBlobIndexNode = node.value;
    if (value.tag === "leaf") {
      if (value.entries.length !== expected) return invalid();
      for (let at = 1; at < value.entries.length; at += 1)
        if (
          (value.entries[at - 1]?.key ?? "") >= (value.entries[at]?.key ?? "")
        )
          return invalid();
      out.push(...value.entries.slice(skip, skip + take));
      return ok(undefined);
    }
    if (value.children.length < 2) return invalid();
    let total = 0;
    for (const child of value.children) {
      if (child.count < 1) return invalid();
      total += child.count;
    }
    if (total !== expected) return invalid();
    let remainingSkip = skip;
    for (const child of value.children) {
      if (out.length - startLength >= wanted) break;
      if (remainingSkip >= child.count) {
        remainingSkip -= child.count;
        continue;
      }
      // The window shrinks as entries are collected, so a deep tree never over-reads.
      const walked = await this.walk(
        element,
        child.root,
        child.count,
        remainingSkip,
        Math.min(
          wanted - (out.length - startLength),
          child.count - remainingSkip,
        ),
        out,
        depth + 1,
      );
      if (walked._tag === "err") return walked;
      remainingSkip = 0;
    }
    return out.length - startLength === wanted ? ok(undefined) : invalid();
  }

  /** The whole text, only when it is within `maxBytes`; the digest, byte and unit counts must all match the root. */
  async readText(
    root: InsightTextRootDescriptor,
    maxBytes: number,
  ): Promise<Result<string, StorageFailure>> {
    if (root.data.bytes > maxBytes) return invalid();
    const blocks = await this.readWholeIndex("BlobBlock", root.data.blocks);
    if (blocks._tag === "err") return blocks;
    const digest = createHash("sha256");
    let text = "";
    let bytes = 0;
    for (const entry of blocks.value) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- each block read is bounded by the text's declared size
      const block = await this.readBlock(entry.value, bytes);
      if (block._tag === "err") return block;
      digest.update(block.value.raw);
      bytes += block.value.raw.length;
      text += block.value.text;
    }
    return bytes === root.data.bytes &&
      text.length === root.utf16Units &&
      digest.digest("hex") === root.data.sha256
      ? ok(text)
      : invalid();
  }

  /** One window of at most `maxUnits` units starting at `position`, without surrogate splitting. */
  async readTextPart(
    root: InsightTextRootDescriptor,
    position: GuideTextPosition,
    maxUnits: number,
  ): Promise<
    Result<
      { readonly text: string; readonly next: GuideTextPosition | null },
      StorageFailure
    >
  > {
    if (root.data.blocks.count === 0)
      return position.block === 0 && position.unit === 0
        ? ok({ text: "", next: null })
        : invalid();
    if (position.block >= root.data.blocks.count) return invalid();
    const found = await this.readIndex(
      "BlobBlock",
      root.data.blocks,
      position.block,
      1,
    );
    if (found._tag === "err") return found;
    const entry = found.value[0];
    if (entry === undefined) return invalid();
    const block = await this.readBlock(entry.value, undefined);
    if (block._tag === "err") return block;
    const { text } = block.value;
    if (position.unit > text.length) return invalid();
    let end = Math.min(position.unit + maxUnits, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    if (end <= position.unit && text.length > position.unit) return invalid();
    const next: GuideTextPosition | null =
      end < text.length
        ? { block: position.block, unit: end }
        : position.block + 1 < root.data.blocks.count
          ? { block: position.block + 1, unit: 0 }
          : null;
    return ok({ text: text.slice(position.unit, end), next });
  }

  private async readBlock(
    reference: InsightArtifactReference,
    expectedStart: number | undefined,
  ): Promise<
    Result<{ readonly raw: Uint8Array; readonly text: string }, StorageFailure>
  > {
    const block = await this.artifacts.readObject(
      this.profileId,
      this.reviewId,
      insightBlobBlockCodec,
      reference,
    );
    if (block._tag === "err") return block;
    if (expectedStart !== undefined && block.value.byteStart !== expectedStart)
      return invalid();
    const raw = await this.artifacts.readBlob(
      this.profileId,
      this.reviewId,
      block.value.bytes,
    );
    if (raw._tag === "err") return raw;
    try {
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(raw.value);
      return raw.value.length === 0 ? invalid() : ok({ raw: raw.value, text });
    } catch {
      return invalid();
    }
  }

  private scope(element: InsightIndexElement) {
    return {
      artifacts: this.artifacts,
      profileId: this.profileId,
      reviewId: this.reviewId,
      element,
    };
  }
}

function invalid(): Result<never, StorageFailure> {
  return err({
    _tag: "StorageFailure",
    operation: "read",
    reason: "invalid_stored_value",
  });
}
