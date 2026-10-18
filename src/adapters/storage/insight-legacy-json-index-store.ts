import type { FileHandle } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import * as v from "valibot";
import { err, ok, type Result } from "#src/domain/result";

const ordinal = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const identity = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const reference = v.nullable(identity);
const linksSchema = v.strictObject({
  left: reference,
  right: reference,
  parent: reference,
  height: v.pipe(ordinal, v.minValue(1)),
});
const rowSchema = v.strictObject({
  id: identity,
  kind: v.picklist([
    "key",
    "string",
    "number",
    "object",
    "array",
    "true",
    "false",
    "null",
  ]),
  parent: reference,
  ordinal,
  key: reference,
  head: reference,
  tail: reference,
  next: reference,
  lookup: linksSchema,
  order: linksSchema,
  value: reference,
  lastKey: reference,
  keyOffset: ordinal,
  keyBytes: ordinal,
  fragments: ordinal,
  index: v.nullable(v.pipe(ordinal, v.maxValue(4294967294))),
  selected: v.boolean(),
  reachable: v.boolean(),
});

/** A fixed disk row retains first-key identity and the current selected value separately. */
export type LegacyJsonIndexRow = v.InferOutput<typeof rowSchema>;

/** Three fixed scratch descriptors remain owned by migration storage. */
export type LegacyJsonIndexFiles = {
  readonly nodes: FileHandle;
  readonly keys: FileHandle;
  readonly properties: FileHandle;
};

/** Disk index failures contain no source bytes, keys or paths. */
export type LegacyJsonIndexFailure = {
  readonly _tag: "LegacyJsonIndexFailure";
  readonly reason:
    | "invalid_spool"
    | "storage_unavailable"
    | "representation_exhausted"
    | "cancelled";
};

/** Only reachable values and selected edges form this private resulting-value view. */
export type LegacyJsonPropertyRecord =
  | { readonly tag: "root"; readonly id: number }
  | {
      readonly tag: "value";
      readonly id: number;
      readonly kind: Exclude<LegacyJsonIndexRow["kind"], "key">;
    }
  | {
      readonly tag: "child";
      readonly parent: number;
      readonly id: number;
      readonly ordinal: number;
      readonly key: number | null;
      readonly firstOrdinal: number;
      readonly lastKey: number | null;
    };

class InvalidIndex extends Error {
  constructor() {
    super("Invalid legacy JSON index");
  }
}

/** Fixed 1024-byte rows and 4096-byte comparisons bound memory independently of object/key size. */
export class InsightLegacyJsonIndexStore {
  private operations = 0;
  private maximumId = 0;

  constructor(
    private readonly files: LegacyJsonIndexFiles,
    private readonly signal?: AbortSignal,
  ) {}
  /** Writes exactly one checked fixed slot, never a variable-size node allocation. */
  writeNode(
    row: LegacyJsonIndexRow,
  ): Promise<Result<void, LegacyJsonIndexFailure>> {
    return this.run(() => this.saveRow(row));
  }

  /** Reads a single canonical row and checks its requested identity. */
  readNode(
    id: number,
  ): Promise<Result<LegacyJsonIndexRow, LegacyJsonIndexFailure>> {
    return this.run(() => this.loadRow(id));
  }

  /** Two AVL trees provide exact-key lookup and property order without an in-memory path stack. */
  indexKey(
    objectId: number,
    keyId: number,
  ): Promise<
    Result<
      { readonly first: LegacyJsonIndexRow; readonly duplicate: boolean },
      LegacyJsonIndexFailure
    >
  > {
    return this.run(async () => {
      const [object, key] = await Promise.all([
        this.loadRow(objectId),
        this.loadRow(keyId),
      ]);
      if (
        object.kind !== "object" ||
        key.kind !== "key" ||
        key.parent !== objectId
      )
        throw new InvalidIndex();
      const lookup = await this.insert(object.head, keyId, "lookup");
      if (lookup.existing !== null)
        return { first: await this.loadRow(lookup.existing), duplicate: true };
      const order = await this.insert(object.tail, keyId, "order");
      if (order.existing !== null) throw new InvalidIndex();
      await this.saveRow({ ...object, head: lookup.root, tail: order.root });
      return { first: await this.loadRow(keyId), duplicate: false };
    });
  }

  /** The successor walk uses disk parent links, including for arbitrarily deep objects. */
  orderedKey(
    root: number | null,
    after: number | null,
  ): Promise<Result<LegacyJsonIndexRow | null, LegacyJsonIndexFailure>> {
    return this.run(async () => {
      let id = root;
      if (after !== null) {
        const row = await this.loadRow(after);
        id = row.order.right;
        if (id !== null) {
          const child = await this.loadRow(id);
          if (child.id === row.id || child.order.parent !== row.id)
            throw new InvalidIndex();
        }
        if (id === null) {
          let current = row;
          for (let steps = 0; current.order.parent !== null; steps += 1) {
            await this.tick(steps);
            const parent = await this.loadRow(current.order.parent);
            if (parent.order.left === current.id) return parent;
            if (parent.order.right !== current.id) throw new InvalidIndex();
            current = parent;
          }
          return null;
        }
      }
      if (id === null) return null;
      let row = await this.loadRow(id);
      for (let steps = 0; row.order.left !== null; steps += 1) {
        await this.tick(steps);
        row = await this.loadRow(row.order.left);
      }
      return row;
    });
  }

  private async saveRow(row: LegacyJsonIndexRow): Promise<void> {
    const parsed = v.safeParse(rowSchema, row);
    if (!parsed.success) throw new InvalidIndex();
    const bytes = Buffer.from(JSON.stringify(parsed.output));
    if (bytes.length > 1020) throw new InvalidIndex();
    const block = Buffer.alloc(1024);
    block.writeUInt32LE(bytes.length);
    bytes.copy(block, 4);
    await this.writeAll(this.files.nodes, block, this.rowPosition(row.id));
    this.maximumId = Math.max(this.maximumId, row.id);
  }

  private async loadRow(id: number): Promise<LegacyJsonIndexRow> {
    const block = Buffer.alloc(1024);
    await this.readAll(this.files.nodes, block, this.rowPosition(id));
    const length = block.readUInt32LE();
    if (length === 0 || length > 1020) throw new InvalidIndex();
    const bytes = block.subarray(4, 4 + length);
    let input: unknown;
    try {
      input = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new InvalidIndex();
    }
    const parsed = v.safeParse(rowSchema, input);
    if (
      !parsed.success ||
      parsed.output.id !== id ||
      !Buffer.from(JSON.stringify(parsed.output)).equals(bytes)
    )
      throw new InvalidIndex();
    return parsed.output;
  }

  private async insert(
    root: number | null,
    id: number,
    mode: "lookup" | "order",
  ): Promise<{ root: number; existing: number | null }> {
    if (root === null) return { root: id, existing: null };
    const key = await this.loadRow(id);
    let cursor = root;
    let previous: number | null = null;
    for (let steps = 0; ; steps += 1) {
      await this.tick(steps);
      const row = await this.loadRow(cursor);
      if (row[mode].parent !== previous || row.parent !== key.parent)
        throw new InvalidIndex();
      const comparison =
        mode === "lookup"
          ? await this.compareKeys(key, row)
          : this.compareOrder(key, row);
      if (comparison === 0) return { root, existing: row.id };
      const side = comparison < 0 ? "left" : "right";
      const next = row[mode][side];
      if (next !== null) {
        previous = cursor;
        cursor = next;
        continue;
      }
      await this.saveRow({ ...row, [mode]: { ...row[mode], [side]: id } });
      const fresh = await this.loadRow(id);
      await this.saveRow({
        ...fresh,
        [mode]: { ...fresh[mode], parent: row.id },
      });
      break;
    }
    let ancestor: number | null = cursor;
    for (let steps = 0; ancestor !== null; steps += 1) {
      await this.tick(steps);
      let row = await this.refreshHeight(ancestor, mode);
      const balance = await this.balance(row, mode);
      if (balance > 1) {
        if (row[mode].left === null) throw new InvalidIndex();
        const left = await this.loadRow(row[mode].left);
        if ((await this.balance(left, mode)) < 0)
          await this.rotate(left.id, mode, "left");
        row = await this.rotate(row.id, mode, "right");
      } else if (balance < -1) {
        if (row[mode].right === null) throw new InvalidIndex();
        const right = await this.loadRow(row[mode].right);
        if ((await this.balance(right, mode)) > 0)
          await this.rotate(right.id, mode, "right");
        row = await this.rotate(row.id, mode, "left");
      }
      if (row[mode].parent === null) root = row.id;
      ancestor = row[mode].parent;
    }
    return { root, existing: null };
  }

  private compareOrder(a: LegacyJsonIndexRow, b: LegacyJsonIndexRow): number {
    if (a.index !== null && b.index !== null) return a.index - b.index;
    if (a.index !== null) return -1;
    if (b.index !== null) return 1;
    return a.ordinal - b.ordinal;
  }

  private async compareKeys(
    a: LegacyJsonIndexRow,
    b: LegacyJsonIndexRow,
  ): Promise<number> {
    if (
      a.kind !== "key" ||
      b.kind !== "key" ||
      a.keyOffset % 2 !== 0 ||
      b.keyOffset % 2 !== 0 ||
      a.keyBytes % 2 !== 0 ||
      b.keyBytes % 2 !== 0
    )
      throw new InvalidIndex();
    const left = Buffer.alloc(4096);
    const right = Buffer.alloc(4096);
    const length = Math.min(a.keyBytes, b.keyBytes);
    for (let offset = 0; offset < length; offset += 4096) {
      await this.tick();
      const count = Math.min(4096, length - offset);
      await this.readAll(
        this.files.keys,
        left.subarray(0, count),
        a.keyOffset + offset,
      );
      await this.readAll(
        this.files.keys,
        right.subarray(0, count),
        b.keyOffset + offset,
      );
      for (let unit = 0; unit < count; unit += 2) {
        const delta = left.readUInt16LE(unit) - right.readUInt16LE(unit);
        if (delta !== 0) return delta;
      }
    }
    return a.keyBytes - b.keyBytes;
  }

  private async height(
    id: number | null,
    mode: "lookup" | "order",
  ): Promise<number> {
    return id === null ? 0 : (await this.loadRow(id))[mode].height;
  }

  private async balance(
    row: LegacyJsonIndexRow,
    mode: "lookup" | "order",
  ): Promise<number> {
    return (
      (await this.height(row[mode].left, mode)) -
      (await this.height(row[mode].right, mode))
    );
  }

  private async refreshHeight(
    id: number,
    mode: "lookup" | "order",
  ): Promise<LegacyJsonIndexRow> {
    const row = await this.loadRow(id);
    const height =
      1 +
      Math.max(
        await this.height(row[mode].left, mode),
        await this.height(row[mode].right, mode),
      );
    const next = { ...row, [mode]: { ...row[mode], height } };
    await this.saveRow(next);
    return next;
  }

  private async rotate(
    id: number,
    mode: "lookup" | "order",
    direction: "left" | "right",
  ): Promise<LegacyJsonIndexRow> {
    const row = await this.loadRow(id);
    const side = direction === "left" ? "right" : "left";
    const opposite = direction === "left" ? "left" : "right";
    const pivotId = row[mode][side];
    if (pivotId === null) throw new InvalidIndex();
    const pivot = await this.loadRow(pivotId);
    if (pivot[mode].parent !== id) throw new InvalidIndex();
    const middle = pivot[mode][opposite];
    if (middle !== null) {
      const child = await this.loadRow(middle);
      if (child[mode].parent !== pivot.id) throw new InvalidIndex();
      await this.saveRow({ ...child, [mode]: { ...child[mode], parent: id } });
    }
    const parentId = row[mode].parent;
    if (parentId !== null) {
      const parent = await this.loadRow(parentId);
      const parentSide = parent[mode].left === id ? "left" : "right";
      if (parent[mode][parentSide] !== id) throw new InvalidIndex();
      await this.saveRow({
        ...parent,
        [mode]: { ...parent[mode], [parentSide]: pivot.id },
      });
    }
    await this.saveRow({
      ...row,
      [mode]: { ...row[mode], [side]: middle, parent: pivot.id },
    });
    await this.saveRow({
      ...pivot,
      [mode]: { ...pivot[mode], [opposite]: id, parent: parentId },
    });
    await this.refreshHeight(id, mode);
    return this.refreshHeight(pivot.id, mode);
  }

  /** UTF16LE stores lone surrogates without Unicode normalization or replacement. */
  writeKeyFragment(
    position: number,
    text: string,
  ): Promise<Result<number, LegacyJsonIndexFailure>> {
    return this.run(async () => {
      if (text.length === 0 || text.length > 2048 || position % 2 !== 0)
        throw new InvalidIndex();
      const bytes = Buffer.from(text, "utf16le");
      await this.writeAll(this.files.keys, bytes, position);
      return bytes.length;
    });
  }

  /** Appends one bounded selected-view record at an explicit checked position. */
  writeProperty(
    position: number,
    record: LegacyJsonPropertyRecord,
  ): Promise<Result<number, LegacyJsonIndexFailure>> {
    return this.run(async () => {
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
      if (bytes.length > 512) throw new InvalidIndex();
      await this.writeAll(this.files.properties, bytes, position);
      return bytes.length;
    });
  }

  private async run<T>(
    operation: () => Promise<T>,
  ): Promise<Result<T, LegacyJsonIndexFailure>> {
    try {
      await this.tick();
      return ok(await operation());
    } catch (cause: unknown) {
      return err({
        _tag: "LegacyJsonIndexFailure",
        reason: this.signal?.aborted
          ? "cancelled"
          : cause instanceof InvalidIndex
            ? "invalid_spool"
            : cause instanceof RangeError
              ? "representation_exhausted"
              : "storage_unavailable",
      });
    }
  }

  private async tick(steps?: number): Promise<void> {
    if (steps !== undefined && steps > this.maximumId) throw new InvalidIndex();
    this.signal?.throwIfAborted();
    this.operations = (this.operations + 1) % 64;
    if (this.operations === 0)
      await setImmediate(undefined, { signal: this.signal });
  }

  private rowPosition(id: number): number {
    if (!Number.isSafeInteger(id) || id < 1) throw new InvalidIndex();
    const position = (id - 1) * 1024;
    this.checkPosition(position, 1024);
    return position;
  }

  private checkPosition(position: number, length: number): void {
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      !Number.isSafeInteger(position + length)
    )
      throw new RangeError("Legacy JSON index position exhausted");
  }

  private async readAll(
    file: FileHandle,
    bytes: Buffer,
    position: number,
  ): Promise<void> {
    this.checkPosition(position, bytes.length);
    let offset = 0;
    while (offset < bytes.length) {
      this.signal?.throwIfAborted();
      const read = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        position + offset,
      );
      if (read.bytesRead === 0) throw new InvalidIndex();
      offset += read.bytesRead;
    }
  }

  private async writeAll(
    file: FileHandle,
    bytes: Buffer,
    position: number,
  ): Promise<void> {
    this.checkPosition(position, bytes.length);
    let offset = 0;
    while (offset < bytes.length) {
      this.signal?.throwIfAborted();
      const written = await file.write(
        bytes,
        offset,
        bytes.length - offset,
        position + offset,
      );
      if (written.bytesWritten === 0)
        throw new Error("Legacy JSON index write did not advance");
      offset += written.bytesWritten;
    }
  }
}
