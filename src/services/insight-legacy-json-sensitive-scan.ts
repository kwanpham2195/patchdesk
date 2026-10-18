import type { FileHandle } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import {
  InsightLegacyJsonIndexStore,
  type LegacyJsonIndexFiles,
  type LegacyJsonIndexRow,
} from "#src/adapters/storage/insight-legacy-json-index-store";
import { err, ok, type Result } from "#src/domain/result";
import type { LegacyJsonStructure } from "./insight-legacy-json-decoder";
import type { LegacyJsonProperties } from "./insight-legacy-json-resolver";
import {
  LegacyJsonStructureReader,
  type LegacyJsonStructureRecord,
} from "./insight-legacy-json-records";
import { LegacySensitiveString } from "./insight-legacy-sensitive-string";

/** Private scan failures disclose no source text, credential fragment, key or path. */
export type LegacyJsonSensitiveFailure = {
  readonly _tag: "LegacyJsonSensitiveFailure";
  readonly reason:
    | "sensitive_value"
    | "invalid_spool"
    | "storage_unavailable"
    | "representation_exhausted"
    | "cancelled";
};

class SensitiveScanError extends Error {
  constructor(readonly reason: LegacyJsonSensitiveFailure["reason"]) {
    super("Legacy JSON sensitive scan failed");
  }
}

type ScalarScan = {
  readonly row: LegacyJsonIndexRow;
  readonly matcher: LegacySensitiveString | undefined;
  fragments: number;
  codeUnits: number;
};

/** Scans the entire selected resulting value, including fields later ignored by stored schemas. */
export async function scanLegacyJsonSensitiveData(
  files: LegacyJsonIndexFiles & { readonly structure: FileHandle },
  structure: LegacyJsonStructure,
  properties: LegacyJsonProperties,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Result<void, LegacyJsonSensitiveFailure>> {
  try {
    const scanner = new SensitiveScanner(
      new InsightLegacyJsonIndexStore(files, options.signal),
      structure,
      properties,
    );
    const reader = new LegacyJsonStructureReader(
      files.structure,
      options.signal,
    );
    let records = 0;
    for (;;) {
      options.signal?.throwIfAborted();
      const record = requireResult(await reader.read());
      if (record === null) break;
      await scanner.consume(record);
      records = add(records, 1);
      if (records % 64 === 0) await setImmediate(undefined, options);
    }
    options.signal?.throwIfAborted();
    scanner.finish(records);
    return ok(undefined);
  } catch (cause: unknown) {
    return err({
      _tag: "LegacyJsonSensitiveFailure",
      reason: options.signal?.aborted
        ? "cancelled"
        : cause instanceof SensitiveScanError
          ? cause.reason
          : cause instanceof RangeError
            ? "representation_exhausted"
            : "storage_unavailable",
    });
  }
}

class SensitiveScanner {
  private scalar: ScalarScan | undefined;
  private nodes = 0;
  private values = 0;
  private keys = 0;
  private reachableValues = 0;
  private selectedProperties = 0;
  private rootSeen = false;

  constructor(
    private readonly store: InsightLegacyJsonIndexStore,
    private readonly structure: LegacyJsonStructure,
    private readonly properties: LegacyJsonProperties,
  ) {}

  async consume(record: LegacyJsonStructureRecord): Promise<void> {
    switch (record.tag) {
      case "node":
        await this.beginNode(record);
        break;
      case "fragment": {
        const scalar = this.scalar;
        if (
          scalar === undefined ||
          scalar.row.id !== record.id ||
          scalar.fragments !== record.sequence
        )
          invalid();
        scalar.fragments = add(scalar.fragments, 1);
        scalar.codeUnits = add(scalar.codeUnits, record.text.length);
        if (scalar.matcher?.write(record.text))
          throw new SensitiveScanError("sensitive_value");
        break;
      }
      case "scalar_end": {
        const scalar = this.scalar;
        if (
          scalar === undefined ||
          scalar.row.id !== record.id ||
          scalar.fragments !== record.fragments ||
          scalar.codeUnits !== record.codeUnits ||
          (scalar.row.kind === "key" &&
            (scalar.row.fragments !== record.fragments ||
              scalar.row.keyBytes !== add(record.codeUnits, record.codeUnits)))
        )
          invalid();
        if (scalar.matcher?.finish())
          throw new SensitiveScanError("sensitive_value");
        this.scalar = undefined;
        break;
      }
      case "root":
        if (this.rootSeen || record.id !== this.structure.root) invalid();
        this.rootSeen = true;
        break;
      case "child":
      case "container_end":
        break;
    }
  }

  finish(records: number): void {
    if (
      this.scalar !== undefined ||
      !this.rootSeen ||
      this.properties.root !== this.structure.root ||
      records !== this.structure.records ||
      this.nodes !== this.properties.nodeRows ||
      this.values !== this.structure.values ||
      this.keys !== this.structure.keys ||
      this.reachableValues !== this.properties.reachableValues ||
      this.selectedProperties !== this.properties.selectedProperties
    )
      invalid();
  }

  private async beginNode(
    record: Extract<LegacyJsonStructureRecord, { tag: "node" }>,
  ): Promise<void> {
    if (this.scalar !== undefined) invalid();
    this.nodes = add(this.nodes, 1);
    if (record.id !== this.nodes || record.id > this.properties.nodeRows)
      invalid();
    const row = await this.read(record.id);
    if (row.kind !== record.kind) invalid();
    let scan = false;
    if (row.kind === "key") {
      this.keys = add(this.keys, 1);
      if (row.parent === null || row.parent >= row.id) invalid();
      const parent = await this.read(row.parent);
      if (parent.kind !== "object") invalid();
      // Only the canonical first name has a value; duplicate occurrences have the identical name.
      if (parent.reachable && row.value !== null) {
        const value = await this.read(row.value);
        if (!value.reachable || !value.selected || value.parent !== parent.id)
          invalid();
        scan = true;
        this.selectedProperties = add(this.selectedProperties, 1);
      }
    } else {
      this.values = add(this.values, 1);
      if (row.reachable) {
        if (!row.selected) invalid();
        if (row.parent === null) {
          if (row.id !== this.structure.root) invalid();
        } else {
          if (row.parent >= row.id) invalid();
          const parent = await this.read(row.parent);
          if (
            !parent.reachable ||
            (parent.kind !== "object" && parent.kind !== "array")
          )
            invalid();
        }
        this.reachableValues = add(this.reachableValues, 1);
        scan = row.kind === "string";
      }
    }
    if (row.kind === "key" || row.kind === "string" || row.kind === "number")
      this.scalar = {
        row,
        matcher:
          scan && row.kind !== "number"
            ? new LegacySensitiveString(row.kind)
            : undefined,
        fragments: 0,
        codeUnits: 0,
      };
  }

  private async read(id: number): Promise<LegacyJsonIndexRow> {
    if (id > this.properties.nodeRows) invalid();
    return requireResult(await this.store.readNode(id));
  }
}

function requireResult<T>(
  result: Result<T, { readonly reason: LegacyJsonSensitiveFailure["reason"] }>,
): T {
  if (result._tag === "err") throw new SensitiveScanError(result.error.reason);
  return result.value;
}

function invalid(): never {
  throw new SensitiveScanError("invalid_spool");
}

function add(value: number, delta: number): number {
  const next = value + delta;
  if (!Number.isSafeInteger(next))
    throw new RangeError("Legacy JSON sensitive scan representation exhausted");
  return next;
}
