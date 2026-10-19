import { createHash } from "node:crypto";

import {
  parseWrappedInsightBlobBlock,
  parseWrappedInsightBlobIndexNode,
} from "#src/domain/insight-artifact-index";
import type { InsightArtifactReference } from "#src/domain/insight-artifact-scalars";
import type { InsightTextRootDescriptor } from "#src/domain/insight-slot-identity-contract";
import { err, ok, type Result } from "#src/domain/result";
import type { StorageFailure } from "./json-file";

/** Identity strings are short IDs; these caps bound reads from stored data before any traversal trusts its counts. */
export const MAX_TEXT_ROOT_BLOCKS = 16;
const MAX_INDEX_NODES = 32;
const MAX_INDEX_DEPTH = MAX_TEXT_ROOT_BLOCKS;

type ReadObject = (
  reference: InsightArtifactReference,
) => Promise<Result<Uint8Array, StorageFailure>>;

type PendingNode = {
  readonly reference: InsightArtifactReference;
  readonly depth: number;
  /** Absent for the root, whose range is only known from the descriptor's count. */
  readonly range?: {
    readonly first: string;
    readonly last: string;
    readonly count: number;
  };
};

/** Streams the TextRoot's blob blocks in key order and accepts it only if its UTF-8 bytes equal `expected`; read failures pass through and every structural failure is invalid_stored_value. */
export async function verifyTextRootEquals(
  readObject: ReadObject,
  root: InsightTextRootDescriptor,
  expected: string,
): Promise<Result<void, StorageFailure>> {
  const expectedBytes = Buffer.from(expected, "utf8");
  if (
    root.data.bytes !== expectedBytes.length ||
    root.utf16Units !== expected.length ||
    root.data.blocks.count > MAX_TEXT_ROOT_BLOCKS
  )
    return invalidRead();
  const digest = createHash("sha256");
  const stack: PendingNode[] = [{ reference: root.data.blocks.root, depth: 0 }];
  let visitedNodes = 0;
  let blocks = 0;
  let offset = 0;
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    visitedNodes += 1;
    if (visitedNodes > MAX_INDEX_NODES || node.depth > MAX_INDEX_DEPTH)
      return invalidRead();
    const bytes = await readObject(node.reference);
    if (bytes._tag === "err") return bytes;
    const parsed = parseWrappedInsightBlobIndexNode(bytes.value);
    if (parsed._tag === "err") return invalidRead();
    const index = parsed.value;
    if (index.tag === "branch") {
      const children = index.children;
      const first = children[0]?.first;
      const last = children.at(-1)?.last;
      if (children.length < 2 || first === undefined || last === undefined)
        return invalidRead();
      let total = 0;
      let previousLast: string | undefined;
      for (const child of children) {
        if (
          child.count < 1 ||
          child.count > MAX_TEXT_ROOT_BLOCKS ||
          child.first > child.last ||
          (previousLast !== undefined && child.first <= previousLast)
        )
          return invalidRead();
        previousLast = child.last;
        total += child.count;
      }
      if (
        node.range !== undefined &&
        (node.range.first !== first ||
          node.range.last !== last ||
          node.range.count !== total)
      )
        return invalidRead();
      for (const child of [...children].reverse())
        stack.push({
          reference: child.root,
          depth: node.depth + 1,
          range: { first: child.first, last: child.last, count: child.count },
        });
      continue;
    }
    const entries = index.entries;
    if (
      node.range !== undefined &&
      (entries.length !== node.range.count ||
        entries[0]?.key !== node.range.first ||
        entries.at(-1)?.key !== node.range.last)
    )
      return invalidRead();
    for (const entry of entries) {
      // BlobBlock indexes use the contract default key: the zero-padded 16-digit block ordinal.
      if (entry.key !== String(blocks).padStart(16, "0")) return invalidRead();
      blocks += 1;
      if (blocks > MAX_TEXT_ROOT_BLOCKS) return invalidRead();
      const blockBytes = await readObject(entry.value);
      if (blockBytes._tag === "err") return blockBytes;
      const block = parseWrappedInsightBlobBlock(blockBytes.value);
      if (block._tag === "err" || block.value.byteStart !== offset)
        return invalidRead();
      const blob = await readObject(block.value.bytes);
      if (blob._tag === "err") return blob;
      const end = offset + blob.value.length;
      if (!expectedBytes.subarray(offset, end).equals(blob.value))
        return invalidRead();
      digest.update(blob.value);
      offset = end;
    }
  }
  return blocks === root.data.blocks.count &&
    offset === expectedBytes.length &&
    digest.digest("hex") === root.data.sha256
    ? ok(undefined)
    : invalidRead();
}

function invalidRead(): Result<never, StorageFailure> {
  return err({
    _tag: "StorageFailure",
    operation: "read",
    reason: "invalid_stored_value",
  });
}
