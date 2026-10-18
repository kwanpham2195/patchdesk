import type { FileHandle } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import * as v from "valibot";
import {
  InsightLegacyJsonIndexStore,
  type LegacyJsonIndexFiles,
  type LegacyJsonIndexRow,
} from "#src/adapters/storage/insight-legacy-json-index-store";
import { parseIsoTimestamp, type ReviewId } from "#src/domain/ids";
import { err, ok, type Result } from "#src/domain/result";
import type { LegacyJsonStructure } from "./insight-legacy-json-decoder";
import type { LegacyJsonProperties } from "./insight-legacy-json-resolver";
import { LegacyJsonStructureReader } from "./insight-legacy-json-records";

const fields = [
  "schemaVersion",
  "reviewId",
  "type",
  "nextToken",
  "updatedAt",
  "retained",
  "dismissals",
  "walkthroughProgress",
  "guideReadingState",
  "analysisVerification",
  "replacementFailure",
  "activeRun",
] as const;
const timestampSchema = v.pipe(v.string(), v.isoTimestamp());

type AnalysisRootFailure = {
  readonly _tag: "LegacyAnalysisRootShapeFailure";
  readonly reason:
    | "invalid_legacy"
    | "invalid_spool"
    | "storage_unavailable"
    | "representation_exhausted"
    | "cancelled";
};

class AnalysisRootError extends Error {
  constructor(readonly reason: AnalysisRootFailure["reason"]) {
    super("Legacy Analysis root shape check failed");
  }
}

type Scalar = {
  readonly id: number;
  readonly field: number;
  fragments: number;
  units: number;
  text: string;
};

/** Returns selected numeric node IDs after root shape/privacy; numeric values and nested schemas remain unchecked here. */
export async function checkLegacyAnalysisRoot(
  files: LegacyJsonIndexFiles & { readonly structure: FileHandle },
  structure: LegacyJsonStructure,
  properties: LegacyJsonProperties,
  reviewId: ReviewId,
  options: { readonly signal?: AbortSignal } = {},
): Promise<
  Result<
    { readonly schemaVersion: number; readonly nextToken: number },
    AnalysisRootFailure
  >
> {
  try {
    const store = new InsightLegacyJsonIndexStore(files, options.signal);
    const read = async (id: number) => {
      if (id > properties.nodeRows) fail("invalid_spool");
      return requireResult(await store.readNode(id));
    };
    const root = await read(structure.root);
    if (
      properties.root !== root.id ||
      root.parent !== null ||
      !root.reachable ||
      !root.selected
    )
      fail("invalid_spool");
    if (root.kind !== "object") fail("invalid_legacy");
    const reader = new LegacyJsonStructureReader(
      files.structure,
      options.signal,
    );
    let mask = 0;
    let schemaVersion: number | undefined;
    let nextToken: number | undefined;
    let scalar: Scalar | undefined;
    let records = 0;
    let nodes = 0;
    let rootSeen = false;
    for (;;) {
      options.signal?.throwIfAborted();
      const record = requireResult(await reader.read());
      if (record === null) break;
      records = add(records, 1);
      if (records % 64 === 0) await setImmediate(undefined, options);
      if (record.tag === "node") {
        if (scalar !== undefined) fail("invalid_spool");
        nodes = add(nodes, 1);
        if (record.id !== nodes) fail("invalid_spool");
        const row = await read(record.id);
        if (row.kind !== record.kind) fail("invalid_spool");
        // A first key keeps its selected value even when a later occurrence supplied that value.
        if (
          row.kind === "key" &&
          row.parent === root.id &&
          row.value !== null
        ) {
          const field = await rootField(
            files.keys,
            row,
            properties.keyBytes,
            options.signal,
          );
          const bit = 1 << field;
          if ((mask & bit) !== 0) fail("invalid_spool");
          mask |= bit;
          const value = await read(row.value);
          if (!value.reachable || !value.selected || value.parent !== root.id)
            fail("invalid_spool");
          const kind =
            field === 0 || field === 3
              ? "number"
              : field === 1 || field === 2 || field === 4
                ? "string"
                : field === 6
                  ? "array"
                  : "object";
          if (value.kind !== kind) fail("invalid_legacy");
          if (field === 0) schemaVersion = value.id;
          if (field === 3) nextToken = value.id;
        } else if (
          row.kind === "string" &&
          row.parent === root.id &&
          row.reachable
        ) {
          if (!row.selected || row.key === null) fail("invalid_spool");
          const key = await read(row.key);
          if (key.kind !== "key" || key.parent !== root.id)
            fail("invalid_spool");
          // The resolver proved exact UTF16 equality of this last occurrence and the canonical first name.
          const field = await rootField(
            files.keys,
            key,
            properties.keyBytes,
            options.signal,
          );
          if (field !== 1 && field !== 2 && field !== 4) fail("invalid_spool");
          scalar = { id: row.id, field, fragments: 0, units: 0, text: "" };
        }
      } else if (record.tag === "fragment" && scalar !== undefined) {
        if (record.id !== scalar.id || record.sequence !== scalar.fragments)
          fail("invalid_spool");
        scalar.fragments = add(scalar.fragments, 1);
        const end = add(scalar.units, record.text.length);
        if (scalar.field === 1) {
          if (end > reviewId.length) fail("invalid_legacy");
          for (let i = 0; i < record.text.length; i += 1)
            if (
              record.text.charCodeAt(i) !==
              reviewId.charCodeAt(scalar.units + i)
            )
              fail("invalid_legacy");
        } else {
          // The intersection with the domain timestamp grammar is exactly 24 code units.
          if (end > (scalar.field === 2 ? 8 : 24)) fail("invalid_legacy");
          scalar.text += record.text;
        }
        scalar.units = end;
      } else if (record.tag === "scalar_end" && scalar !== undefined) {
        if (
          record.id !== scalar.id ||
          record.fragments !== scalar.fragments ||
          record.codeUnits !== scalar.units
        )
          fail("invalid_spool");
        if (
          scalar.field === 1
            ? scalar.units !== reviewId.length
            : scalar.field === 2
              ? scalar.text !== "analysis"
              : !v.safeParse(timestampSchema, scalar.text).success ||
                parseIsoTimestamp(scalar.text)._tag === "err"
        )
          fail("invalid_legacy");
        scalar = undefined;
      } else if (record.tag === "root") {
        if (rootSeen || record.id !== root.id) fail("invalid_spool");
        rootSeen = true;
      }
    }
    if (
      scalar !== undefined ||
      !rootSeen ||
      records !== structure.records ||
      nodes !== properties.nodeRows
    )
      fail("invalid_spool");
    if ((mask & 31) !== 31) fail("invalid_legacy");
    if (schemaVersion === undefined || nextToken === undefined)
      fail("invalid_spool");
    options.signal?.throwIfAborted();
    return ok({ schemaVersion, nextToken });
  } catch (cause: unknown) {
    return err({
      _tag: "LegacyAnalysisRootShapeFailure",
      reason: options.signal?.aborted
        ? "cancelled"
        : cause instanceof AnalysisRootError
          ? cause.reason
          : cause instanceof RangeError
            ? "representation_exhausted"
            : "storage_unavailable",
    });
  }
}

async function rootField(
  keys: FileHandle,
  row: LegacyJsonIndexRow,
  keyBytes: number,
  signal: AbortSignal | undefined,
): Promise<number> {
  const end = add(row.keyOffset, row.keyBytes);
  if (row.keyOffset % 2 !== 0 || row.keyBytes % 2 !== 0 || end > keyBytes)
    fail("invalid_spool");
  // Length rejects arbitrary names without allocating or reconstructing their text.
  if (row.keyBytes > 42) fail("invalid_legacy");
  const bytes = Buffer.alloc(42);
  let offset = 0;
  while (offset < row.keyBytes) {
    signal?.throwIfAborted();
    const read = await keys.read(
      bytes,
      offset,
      row.keyBytes - offset,
      add(row.keyOffset, offset),
    );
    if (read.bytesRead === 0) fail("invalid_spool");
    offset = add(offset, read.bytesRead);
  }
  for (let field = 0; field < fields.length; field += 1) {
    const name = fields[field];
    if (name === undefined || name.length * 2 !== row.keyBytes) continue;
    let matches = true;
    for (let i = 0; i < name.length; i += 1)
      if (bytes.readUInt16LE(i * 2) !== name.charCodeAt(i)) matches = false;
    if (matches) return field;
  }
  return fail("invalid_legacy");
}

function requireResult<T>(
  result: Result<T, { readonly reason: AnalysisRootFailure["reason"] }>,
): T {
  if (result._tag === "err") fail(result.error.reason);
  return result.value;
}

function fail(reason: AnalysisRootFailure["reason"]): never {
  throw new AnalysisRootError(reason);
}

function add(value: number, delta: number): number {
  const next = value + delta;
  if (!Number.isSafeInteger(next))
    throw new RangeError("Legacy Analysis root shape position exhausted");
  return next;
}
