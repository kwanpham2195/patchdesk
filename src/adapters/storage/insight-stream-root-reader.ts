import { createHash } from "node:crypto";
import {
  parseWrappedInsightBlobBlock,
  parseWrappedInsightBlobIndexNode,
} from "#src/domain/insight-artifact-index";
import type {
  InsightArtifactReference,
  InsightTextRootDescriptor,
} from "#src/domain/insight-artifact-scalars";
import { err, ok, type Result } from "#src/domain/result";
import type { StorageFailure } from "./json-file";
import { MAX_INSIGHT_OBJECT_BYTES } from "./insight-artifact-files";

type ReadObject = (
  reference: InsightArtifactReference,
) => Promise<Result<Uint8Array, StorageFailure>>;

/** Verifies every stored block and index edge without retaining a graph, recursion path or complete text. */
export async function verifyInsightStreamTextRoot(
  read: ReadObject,
  root: InsightTextRootDescriptor,
  options: { readonly signal?: AbortSignal },
): Promise<Result<void, StorageFailure>> {
  const hash = createHash("sha256");
  let bytes = 0;
  let units = 0;
  if (root.data.blocks.count === 0) {
    const empty = await verified(read, root.data.blocks.root);
    if (empty._tag === "err") return empty;
    const parsed = parseWrappedInsightBlobIndexNode(empty.value);
    if (
      parsed._tag === "err" ||
      parsed.value.tag !== "leaf" ||
      parsed.value.entries.length !== 0
    )
      return invalid();
  }
  for (let ordinal = 0; ordinal < root.data.blocks.count; ordinal += 1) {
    if (options.signal?.aborted) return invalid();
    const reference = await findBlock(read, root, ordinal, options);
    if (reference._tag === "err") return reference;
    const encoded = await verified(read, reference.value);
    if (encoded._tag === "err") return encoded;
    const block = parseWrappedInsightBlobBlock(encoded.value);
    if (block._tag === "err" || block.value.byteStart !== bytes)
      return invalid();
    const raw = await verified(read, block.value.bytes);
    if (raw._tag === "err") return raw;
    if (raw.value.length === 0) return invalid();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        raw.value,
      );
    } catch {
      return invalid();
    }
    const nextBytes = bytes + raw.value.length;
    const nextUnits = units + text.length;
    if (!Number.isSafeInteger(nextBytes) || !Number.isSafeInteger(nextUnits))
      return invalid();
    bytes = nextBytes;
    units = nextUnits;
    hash.update(raw.value);
  }
  return !options.signal?.aborted &&
    bytes === root.data.bytes &&
    units === root.utf16Units &&
    hash.digest("hex") === root.data.sha256
    ? ok(undefined)
    : invalid();
}

async function findBlock(
  read: ReadObject,
  root: InsightTextRootDescriptor,
  ordinal: number,
  options: { readonly signal?: AbortSignal },
): Promise<Result<InsightArtifactReference, StorageFailure>> {
  let reference = root.data.blocks.root;
  let first = 0;
  let count = root.data.blocks.count;
  // Revisit the root per ordinal instead of retaining a depth-sized heap stack or visited set.
  // Exact ordinal ranges and strictly decreasing positive counts reject cyclic/repeated descent.
  for (;;) {
    if (options.signal?.aborted) return invalid();
    const encoded = await verified(read, reference);
    if (encoded._tag === "err") return encoded;
    const parsed = parseWrappedInsightBlobIndexNode(encoded.value);
    if (parsed._tag === "err") return invalid();
    const node = parsed.value;
    if (node.tag === "leaf") {
      if (node.entries.length !== count) return invalid();
      for (let index = 0; index < node.entries.length; index += 1) {
        if (node.entries[index]?.key !== ordinalKey(first + index))
          return invalid();
      }
      const entry = node.entries[ordinal - first];
      return entry === undefined ? invalid() : ok(entry.value);
    }
    if (node.children.length < 2) return invalid();
    let nextFirst = first;
    let selected:
      | {
          readonly root: InsightArtifactReference;
          readonly first: number;
          readonly count: number;
        }
      | undefined;
    for (const child of node.children) {
      const end = nextFirst + child.count;
      if (
        child.count < 1 ||
        child.count >= count ||
        !Number.isSafeInteger(end) ||
        child.first !== ordinalKey(nextFirst) ||
        child.last !== ordinalKey(end - 1)
      )
        return invalid();
      if (ordinal >= nextFirst && ordinal < end)
        selected = { root: child.root, first: nextFirst, count: child.count };
      nextFirst = end;
    }
    if (nextFirst - first !== count || selected === undefined) return invalid();
    reference = selected.root;
    first = selected.first;
    count = selected.count;
  }
}

async function verified(
  read: ReadObject,
  reference: InsightArtifactReference,
): Promise<Result<Uint8Array, StorageFailure>> {
  const result = await read(reference);
  if (result._tag === "err") return result;
  return result.value.length <= MAX_INSIGHT_OBJECT_BYTES &&
    result.value.length === reference.bytes &&
    createHash("sha256").update(result.value).digest("hex") === reference.hash
    ? result
    : invalid();
}

function ordinalKey(value: number): string {
  return String(value).padStart(16, "0");
}

function invalid(): Result<never, StorageFailure> {
  return err({
    _tag: "StorageFailure",
    operation: "read",
    reason: "invalid_stored_value",
  });
}
