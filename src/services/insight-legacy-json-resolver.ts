import type { FileHandle } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import {
  InsightLegacyJsonIndexStore,
  type LegacyJsonIndexFiles,
  type LegacyJsonIndexRow,
  type LegacyJsonPropertyRecord,
} from "#src/adapters/storage/insight-legacy-json-index-store";
import { err, ok, type Result } from "#src/domain/result";
import type { LegacyJsonStructure } from "./insight-legacy-json-decoder";
import {
  LegacyJsonStructureReader,
  type LegacyJsonStructureRecord,
} from "./insight-legacy-json-records";

/** Counts distinguish raw occurrences, all-object duplicate selection and the reachable resulting view. */
export type LegacyJsonProperties = {
  readonly root: number;
  readonly nodeRows: number;
  readonly keyBytes: number;
  readonly sourceProperties: number;
  readonly duplicateProperties: number;
  readonly reachableValues: number;
  readonly selectedProperties: number;
  readonly arrayElements: number;
  readonly records: number;
  readonly indexRowBytes: 1024;
};

/** Expected failures leave original bytes and the structural occurrence spool intact. */
export type LegacyJsonResolveFailure = {
  readonly _tag: "LegacyJsonResolveFailure";
  readonly reason:
    | "invalid_spool"
    | "storage_unavailable"
    | "representation_exhausted"
    | "cancelled";
};

class ResolutionError extends Error {
  constructor(readonly reason: LegacyJsonResolveFailure["reason"]) {
    super("Legacy JSON property resolution failed");
  }
}

/** Resolves last values/first positions before later sensitive scanning and schema acceptance. */
export async function resolveLegacyJsonProperties(
  files: LegacyJsonIndexFiles & { readonly structure: FileHandle },
  structure: LegacyJsonStructure,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Result<LegacyJsonProperties, LegacyJsonResolveFailure>> {
  try {
    const resolver = new PropertyResolver(
      new InsightLegacyJsonIndexStore(files, options.signal),
      structure,
      options.signal,
    );
    const reader = new LegacyJsonStructureReader(
      files.structure,
      options.signal,
    );
    for (;;) {
      const record = requireResult(await reader.read());
      if (record === null) break;
      await resolver.consume(record);
    }
    return ok(await resolver.finish());
  } catch (cause: unknown) {
    return err({
      _tag: "LegacyJsonResolveFailure",
      reason: options.signal?.aborted
        ? "cancelled"
        : cause instanceof ResolutionError
          ? cause.reason
          : cause instanceof RangeError
            ? "representation_exhausted"
            : "storage_unavailable",
    });
  }
}

class PropertyResolver {
  private nodes = 0;
  private values = 0;
  private keys = 0;
  private records = 0;
  private root: number | undefined;
  private keyBytes = 0;
  private activeKey: LegacyJsonIndexRow | undefined;
  private numeric = 0;
  private numericValid = true;
  private keyUnits = 0;
  private sourceProperties = 0;
  private duplicateProperties = 0;
  private reachableValues = 0;
  private selectedProperties = 0;
  private arrayElements = 0;
  private outputBytes = 0;
  private outputRecords = 0;

  constructor(
    private readonly store: InsightLegacyJsonIndexStore,
    private readonly structure: LegacyJsonStructure,
    private readonly signal?: AbortSignal,
  ) {}

  async consume(record: LegacyJsonStructureRecord): Promise<void> {
    this.records = add(this.records, 1);
    await this.tick(this.records);
    if (record.tag === "node") {
      this.nodes = add(this.nodes, 1);
      if (record.id !== this.nodes || this.activeKey !== undefined) invalid();
      const row: LegacyJsonIndexRow = {
        id: record.id,
        kind: record.kind,
        parent: null,
        ordinal: 0,
        key: null,
        head: null,
        tail: null,
        next: null,
        value: null,
        lastKey: null,
        lookup: { left: null, right: null, parent: null, height: 1 },
        order: { left: null, right: null, parent: null, height: 1 },
        keyOffset: this.keyBytes,
        keyBytes: 0,
        fragments: 0,
        index: null,
        selected: false,
        reachable: false,
      };
      await this.save(row);
      if (row.kind === "key") {
        this.keys = add(this.keys, 1);
        this.activeKey = row;
        this.numeric = 0;
        this.numericValid = true;
        this.keyUnits = 0;
      } else this.values = add(this.values, 1);
    } else if (record.tag === "root") {
      if (this.root !== undefined || record.id !== this.structure.root)
        invalid();
      const row = await this.read(record.id);
      if (row.kind === "key" || row.parent !== null) invalid();
      this.root = record.id;
      await this.save({ ...row, selected: true });
    } else if (record.tag === "fragment" && this.activeKey !== undefined) {
      const key = this.activeKey;
      if (record.id !== key.id || record.sequence !== key.fragments) invalid();
      const bytes = requireResult(
        await this.store.writeKeyFragment(this.keyBytes, record.text),
      );
      this.keyBytes = add(this.keyBytes, bytes);
      this.activeKey = {
        ...key,
        keyBytes: add(key.keyBytes, bytes),
        fragments: add(key.fragments, 1),
      };
      for (let i = 0; i < record.text.length; i += 1) {
        const unit = record.text.charCodeAt(i);
        if (unit < 48 || unit > 57 || (this.keyUnits > 0 && this.numeric === 0))
          this.numericValid = false;
        if (this.numericValid) {
          this.numeric = this.numeric * 10 + unit - 48;
          if (this.numeric > 4294967294) this.numericValid = false;
        }
        this.keyUnits = add(this.keyUnits, 1);
      }
    } else if (record.tag === "scalar_end" && this.activeKey !== undefined) {
      const key = this.activeKey;
      if (
        record.id !== key.id ||
        record.fragments !== key.fragments ||
        record.codeUnits !== this.keyUnits
      )
        invalid();
      await this.save({
        ...key,
        index: this.numericValid && this.keyUnits > 0 ? this.numeric : null,
      });
      this.activeKey = undefined;
    } else if (record.tag === "child") await this.selectChild(record);
  }

  async finish(): Promise<LegacyJsonProperties> {
    if (
      this.activeKey !== undefined ||
      this.root !== this.structure.root ||
      this.records !== this.structure.records ||
      this.values !== this.structure.values ||
      this.keys !== this.structure.keys
    )
      invalid();
    // Source node IDs are preorder: each parent is settled before its descendants.
    for (let id = 1; id <= this.nodes; id = add(id, 1)) {
      await this.tick(id);
      const row = await this.read(id);
      if (row.kind === "key") continue;
      let reachable = id === this.root;
      if (row.parent !== null) {
        if (row.parent >= id) invalid();
        const parent = await this.read(row.parent);
        reachable = row.selected && parent.reachable;
      } else if (!reachable) invalid();
      await this.save({ ...row, reachable });
      if (reachable) this.reachableValues = add(this.reachableValues, 1);
    }
    await this.emit({ tag: "root", id: this.structure.root });
    for (let id = 1; id <= this.nodes; id = add(id, 1)) {
      await this.tick(id);
      const row = await this.read(id);
      if (!row.reachable || row.kind === "key") continue;
      await this.emit({ tag: "value", id, kind: row.kind });
      if (row.kind === "object") await this.emitObject(row);
      else if (row.kind === "array") await this.emitArray(row);
    }
    this.signal?.throwIfAborted();
    return {
      root: this.structure.root,
      nodeRows: this.nodes,
      keyBytes: this.keyBytes,
      sourceProperties: this.sourceProperties,
      duplicateProperties: this.duplicateProperties,
      reachableValues: this.reachableValues,
      selectedProperties: this.selectedProperties,
      arrayElements: this.arrayElements,
      records: this.outputRecords,
      indexRowBytes: 1024,
    };
  }

  private async selectChild(
    record: Extract<LegacyJsonStructureRecord, { tag: "child" }>,
  ): Promise<void> {
    const [child, parent] = await Promise.all([
      this.read(record.id),
      this.read(record.parent),
    ]);
    if (
      parent.id >= child.id ||
      child.parent !== null ||
      child.kind === "key" ||
      record.ordinal !== parent.fragments
    )
      invalid();
    await this.save({ ...parent, fragments: add(parent.fragments, 1) });
    await this.save({
      ...child,
      parent: parent.id,
      ordinal: record.ordinal,
      key: record.key,
      selected: true,
    });
    if (parent.kind === "array") {
      if (record.key !== null) invalid();
      if (parent.tail !== null) {
        const tail = await this.read(parent.tail);
        await this.save({ ...tail, next: child.id });
      }
      await this.save({
        ...parent,
        fragments: add(parent.fragments, 1),
        head: parent.head ?? child.id,
        tail: child.id,
      });
      return;
    }
    if (
      parent.kind !== "object" ||
      record.key === null ||
      this.activeKey !== undefined
    )
      invalid();
    const key = await this.read(record.key);
    if (key.kind !== "key" || key.parent !== null || key.id >= child.id)
      invalid();
    await this.save({ ...key, parent: parent.id, ordinal: record.ordinal });
    this.sourceProperties = add(this.sourceProperties, 1);
    const indexed = requireResult(await this.store.indexKey(parent.id, key.id));
    if (indexed.duplicate) {
      this.duplicateProperties = add(this.duplicateProperties, 1);
      if (indexed.first.value === null) invalid();
      const previous = await this.read(indexed.first.value);
      await this.save({ ...previous, selected: false });
    }
    await this.save({ ...indexed.first, value: child.id, lastKey: key.id });
  }

  private async emitObject(object: LegacyJsonIndexRow): Promise<void> {
    let after: number | null = null;
    let ordinal = 0;
    for (;;) {
      const key: LegacyJsonIndexRow | null = requireResult(
        await this.store.orderedKey(object.tail, after),
      );
      if (key === null) break;
      if (ordinal >= object.fragments) invalid();
      if (
        key.parent !== object.id ||
        key.value === null ||
        key.lastKey === null
      )
        invalid();
      const child = await this.read(key.value);
      if (!child.reachable || !child.selected || child.parent !== object.id)
        invalid();
      await this.emit({
        tag: "child",
        parent: object.id,
        id: child.id,
        ordinal,
        key: key.id,
        firstOrdinal: key.ordinal,
        lastKey: key.lastKey,
      });
      this.selectedProperties = add(this.selectedProperties, 1);
      ordinal = add(ordinal, 1);
      after = key.id;
    }
  }

  private async emitArray(array: LegacyJsonIndexRow): Promise<void> {
    let id = array.head;
    let ordinal = 0;
    while (id !== null) {
      const child = await this.read(id);
      if (
        child.parent !== array.id ||
        child.ordinal !== ordinal ||
        !child.reachable ||
        !child.selected
      )
        invalid();
      await this.emit({
        tag: "child",
        parent: array.id,
        id: child.id,
        ordinal,
        key: null,
        firstOrdinal: ordinal,
        lastKey: null,
      });
      this.arrayElements = add(this.arrayElements, 1);
      ordinal = add(ordinal, 1);
      id = child.next;
    }
    if (ordinal !== array.fragments) invalid();
  }

  private async read(id: number): Promise<LegacyJsonIndexRow> {
    if (id > this.nodes) invalid();
    return requireResult(await this.store.readNode(id));
  }

  private async save(row: LegacyJsonIndexRow): Promise<void> {
    requireResult(await this.store.writeNode(row));
  }

  private async emit(record: LegacyJsonPropertyRecord): Promise<void> {
    this.outputBytes = add(
      this.outputBytes,
      requireResult(await this.store.writeProperty(this.outputBytes, record)),
    );
    this.outputRecords = add(this.outputRecords, 1);
  }

  private async tick(count: number): Promise<void> {
    this.signal?.throwIfAborted();
    if (count % 64 === 0)
      await setImmediate(undefined, { signal: this.signal });
  }
}

function requireResult<T>(
  result: Result<T, { readonly reason: LegacyJsonResolveFailure["reason"] }>,
): T {
  if (result._tag === "err") throw new ResolutionError(result.error.reason);
  return result.value;
}

function invalid(): never {
  throw new ResolutionError("invalid_spool");
}

function add(value: number, delta: number): number {
  const next = value + delta;
  if (!Number.isSafeInteger(next))
    throw new RangeError("Legacy JSON property representation exhausted");
  return next;
}
