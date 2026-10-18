import type { FileHandle } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import * as v from "valibot";
import { err, ok, type Result } from "#src/domain/result";

const recordBytes = 16384;
const frameBytes = 512;
const ordinalSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const nodeSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const tokenSchema = v.union([
  v.strictObject({
    tag: v.literal("punctuation"),
    value: v.picklist(["{", "}", "[", "]", ":", ","]),
  }),
  v.strictObject({
    tag: v.picklist([
      "string_start",
      "string_end",
      "number_start",
      "number_end",
    ]),
  }),
  v.strictObject({
    tag: v.picklist(["string_fragment", "number_fragment"]),
    value: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
  }),
  v.strictObject({
    tag: v.literal("literal"),
    value: v.picklist(["true", "false", "null"]),
  }),
]);
const frameSchema = v.union([
  v.strictObject({
    node: nodeSchema,
    container: v.literal("object"),
    expect: v.picklist(["key_or_end", "key", "colon", "value", "comma_or_end"]),
    key: v.nullable(nodeSchema),
    next: ordinalSchema,
  }),
  v.strictObject({
    node: nodeSchema,
    container: v.literal("array"),
    expect: v.picklist(["value_or_end", "value", "comma_or_end"]),
    key: v.null(),
    next: ordinalSchema,
  }),
]);
type Frame = v.InferOutput<typeof frameSchema>;
type Scalar = {
  readonly id: number;
  readonly kind: "key" | "string" | "number";
  sequence: number;
  codeUnits: number;
};
type NodeKind =
  | "key"
  | "string"
  | "number"
  | "object"
  | "array"
  | "true"
  | "false"
  | "null";
type StructureRecord =
  | { readonly tag: "node"; readonly id: number; readonly kind: NodeKind }
  | { readonly tag: "root"; readonly id: number }
  | {
      readonly tag: "child";
      readonly parent: number;
      readonly id: number;
      readonly ordinal: number;
      readonly key: number | null;
    }
  | {
      readonly tag: "fragment";
      readonly id: number;
      readonly sequence: number;
      readonly text: string;
    }
  | {
      readonly tag: "scalar_end";
      readonly id: number;
      readonly fragments: number;
      readonly codeUnits: number;
    }
  | {
      readonly tag: "container_end";
      readonly id: number;
      readonly children: number;
    };

/** A structural checkpoint preserves every occurrence; it has not resolved keys or accepted a stored schema. */
export type LegacyJsonStructure = {
  readonly root: number;
  readonly values: number;
  readonly keys: number;
  readonly records: number;
  readonly maxDepth: number;
};

/** These fixed descriptors belong to storage; the decoder neither opens paths nor owns their lifetime. */
export type LegacyJsonStructureFiles = {
  readonly tokens: FileHandle;
  readonly frames: FileHandle;
  readonly structure: FileHandle;
};

/** Decoder failures expose safe categories without source text or raw I/O causes. */
export type LegacyJsonDecodeFailure = {
  readonly _tag: "LegacyJsonDecodeFailure";
  readonly reason:
    | "invalid_legacy"
    | "invalid_spool"
    | "storage_unavailable"
    | "representation_exhausted"
    | "cancelled";
};

class LegacyJsonStructureError extends Error {
  readonly _tag = "LegacyJsonStructureError";

  constructor(readonly reason: "invalid_legacy" | "invalid_spool") {
    super("Invalid legacy JSON structure");
  }
}

/** Consumes bounded lexical records using one current frame and a flat disk stack, preserving all key occurrences. */
export async function decodeLegacyJson(
  files: LegacyJsonStructureFiles,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Result<LegacyJsonStructure, LegacyJsonDecodeFailure>> {
  try {
    const decoder = new StructuralDecoder(files);
    let tokens = 0;
    for await (const bytes of readTokenRecords(files.tokens, options.signal)) {
      const token = parsePrivateRecord(bytes, tokenSchema);
      await decoder.consume(token);
      tokens = checkedAdd(tokens, 1);
      if (tokens % 64 === 0) await setImmediate(undefined, options);
    }
    options.signal?.throwIfAborted();
    return ok(decoder.finish());
  } catch (cause: unknown) {
    const reason = options.signal?.aborted
      ? "cancelled"
      : cause instanceof LegacyJsonStructureError
        ? cause.reason
        : cause instanceof RangeError
          ? "representation_exhausted"
          : "storage_unavailable";
    return err({ _tag: "LegacyJsonDecodeFailure", reason });
  }
}

class StructuralDecoder {
  private frame: Frame | undefined;
  private scalar: Scalar | undefined;
  private depth = 0;
  private nextId = 0;
  private root: number | undefined;
  private values = 0;
  private keys = 0;
  private records = 0;
  private maxDepth = 0;

  constructor(private readonly files: LegacyJsonStructureFiles) {}

  async consume(token: v.InferOutput<typeof tokenSchema>): Promise<void> {
    if (this.scalar !== undefined) {
      await this.consumeScalar(token, this.scalar);
      return;
    }
    if (token.tag === "punctuation") {
      if (token.value === "{" || token.value === "[") {
        const container = token.value === "{" ? "object" : "array";
        const id = await this.beginValue(container);
        this.depth = checkedAdd(this.depth, 1);
        this.maxDepth = Math.max(this.maxDepth, this.depth);
        this.frame =
          container === "object"
            ? { node: id, container, expect: "key_or_end", key: null, next: 0 }
            : {
                node: id,
                container,
                expect: "value_or_end",
                key: null,
                next: 0,
              };
        await this.saveFrame(this.frame);
      } else await this.consumePunctuation(token.value);
      return;
    }
    if (token.tag === "string_start") {
      const key =
        this.frame?.container === "object" &&
        (this.frame.expect === "key" || this.frame.expect === "key_or_end");
      let id: number;
      if (key) {
        id = this.allocate();
        this.keys = checkedAdd(this.keys, 1);
        await this.emit({ tag: "node", id, kind: "key" });
      } else id = await this.beginValue("string");
      this.scalar = {
        id,
        kind: key ? "key" : "string",
        sequence: 0,
        codeUnits: 0,
      };
    } else if (token.tag === "number_start") {
      this.scalar = {
        id: await this.beginValue("number"),
        kind: "number",
        sequence: 0,
        codeUnits: 0,
      };
    } else if (token.tag === "literal") await this.beginValue(token.value);
    else throw new LegacyJsonStructureError("invalid_legacy");
  }

  finish(): LegacyJsonStructure {
    if (
      this.root === undefined ||
      this.frame !== undefined ||
      this.scalar !== undefined ||
      this.depth !== 0
    )
      throw new LegacyJsonStructureError("invalid_legacy");
    return {
      root: this.root,
      values: this.values,
      keys: this.keys,
      records: this.records,
      maxDepth: this.maxDepth,
    };
  }

  private async consumeScalar(
    token: v.InferOutput<typeof tokenSchema>,
    scalar: Scalar,
  ): Promise<void> {
    if (
      (token.tag === "string_fragment" && scalar.kind !== "number") ||
      (token.tag === "number_fragment" && scalar.kind === "number")
    ) {
      await this.emit({
        tag: "fragment",
        id: scalar.id,
        sequence: scalar.sequence,
        text: token.value,
      });
      scalar.sequence = checkedAdd(scalar.sequence, 1);
      scalar.codeUnits = checkedAdd(scalar.codeUnits, token.value.length);
      return;
    }
    if (
      (token.tag !== "string_end" || scalar.kind === "number") &&
      (token.tag !== "number_end" || scalar.kind !== "number")
    )
      throw new LegacyJsonStructureError("invalid_legacy");
    if (scalar.kind === "number" && scalar.sequence === 0)
      throw new LegacyJsonStructureError("invalid_spool");
    await this.emit({
      tag: "scalar_end",
      id: scalar.id,
      fragments: scalar.sequence,
      codeUnits: scalar.codeUnits,
    });
    this.scalar = undefined;
    if (scalar.kind === "key") {
      if (
        this.frame?.container !== "object" ||
        (this.frame.expect !== "key" && this.frame.expect !== "key_or_end")
      )
        throw new LegacyJsonStructureError("invalid_legacy");
      this.frame = { ...this.frame, expect: "colon", key: scalar.id };
      await this.saveFrame(this.frame);
    }
  }

  private async beginValue(kind: Exclude<NodeKind, "key">): Promise<number> {
    const frame = this.frame;
    if (
      frame !== undefined &&
      frame.expect !== "value" &&
      frame.expect !== "value_or_end"
    )
      throw new LegacyJsonStructureError("invalid_legacy");
    if (frame === undefined && this.root !== undefined)
      throw new LegacyJsonStructureError("invalid_legacy");
    const id = this.allocate();
    this.values = checkedAdd(this.values, 1);
    await this.emit({ tag: "node", id, kind });
    if (frame === undefined) {
      this.root = id;
      await this.emit({ tag: "root", id });
    } else {
      if (frame.container === "object" && frame.key === null)
        throw new LegacyJsonStructureError("invalid_legacy");
      await this.emit({
        tag: "child",
        parent: frame.node,
        id,
        ordinal: frame.next,
        key: frame.key,
      });
      this.frame = {
        ...frame,
        expect: "comma_or_end",
        key: null,
        next: checkedAdd(frame.next, 1),
      };
      await this.saveFrame(this.frame);
    }
    return id;
  }

  private async consumePunctuation(
    value: "}" | "]" | ":" | ",",
  ): Promise<void> {
    const frame = this.frame;
    if (frame === undefined)
      throw new LegacyJsonStructureError("invalid_legacy");
    if (value === ":") {
      if (frame.container !== "object" || frame.expect !== "colon")
        throw new LegacyJsonStructureError("invalid_legacy");
      this.frame = { ...frame, expect: "value" };
    } else if (value === ",") {
      if (frame.expect !== "comma_or_end")
        throw new LegacyJsonStructureError("invalid_legacy");
      this.frame =
        frame.container === "object"
          ? { ...frame, expect: "key" }
          : { ...frame, expect: "value" };
    } else {
      const correctEnd =
        frame.container === "object" ? value === "}" : value === "]";
      const complete =
        frame.expect === "comma_or_end" ||
        frame.expect === "key_or_end" ||
        frame.expect === "value_or_end";
      if (!correctEnd || !complete)
        throw new LegacyJsonStructureError("invalid_legacy");
      await this.emit({
        tag: "container_end",
        id: frame.node,
        children: frame.next,
      });
      this.depth -= 1;
      this.frame = this.depth === 0 ? undefined : await this.loadFrame();
      return;
    }
    await this.saveFrame(this.frame);
  }

  private allocate(): number {
    this.nextId = checkedAdd(this.nextId, 1);
    return this.nextId;
  }

  private async emit(record: StructureRecord): Promise<void> {
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    if (bytes.length > recordBytes)
      throw new LegacyJsonStructureError("invalid_spool");
    await this.files.structure.writeFile(bytes);
    this.records = checkedAdd(this.records, 1);
  }

  private async saveFrame(frame: Frame): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(frame));
    if (bytes.length > frameBytes - 4)
      throw new LegacyJsonStructureError("invalid_spool");
    const block = Buffer.alloc(frameBytes);
    block.writeUInt32LE(bytes.length);
    bytes.copy(block, 4);
    const position = framePosition(this.depth);
    let offset = 0;
    while (offset < block.length) {
      const written = await this.files.frames.write(
        block,
        offset,
        block.length - offset,
        position + offset,
      );
      if (written.bytesWritten === 0)
        throw new Error("Legacy JSON frame write did not advance");
      offset += written.bytesWritten;
    }
  }

  private async loadFrame(): Promise<Frame> {
    const block = Buffer.alloc(frameBytes);
    const position = framePosition(this.depth);
    let offset = 0;
    while (offset < block.length) {
      const read = await this.files.frames.read(
        block,
        offset,
        block.length - offset,
        position + offset,
      );
      if (read.bytesRead === 0)
        throw new LegacyJsonStructureError("invalid_spool");
      offset += read.bytesRead;
    }
    const length = block.readUInt32LE();
    if (length === 0 || length > frameBytes - 4)
      throw new LegacyJsonStructureError("invalid_spool");
    const bytes = block.subarray(4, 4 + length);
    const frame = parsePrivateRecord(bytes, frameSchema);
    if (
      frame.container === "object" &&
      (frame.expect === "colon" || frame.expect === "value") !==
        (frame.key !== null)
    )
      throw new LegacyJsonStructureError("invalid_spool");
    return frame;
  }
}

function parsePrivateRecord<T extends typeof tokenSchema | typeof frameSchema>(
  bytes: Buffer,
  schema: T,
): v.InferOutput<T> {
  if (bytes.length === 0 || bytes.length >= recordBytes)
    throw new LegacyJsonStructureError("invalid_spool");
  try {
    const input: unknown = JSON.parse(bytes.toString("utf8"));
    const parsed = v.safeParse(schema, input);
    if (
      !parsed.success ||
      !Buffer.from(JSON.stringify(parsed.output)).equals(bytes)
    )
      throw new LegacyJsonStructureError("invalid_spool");
    return parsed.output;
  } catch {
    throw new LegacyJsonStructureError("invalid_spool");
  }
}

function checkedAdd(value: number, delta: number): number {
  const next = value + delta;
  if (!Number.isSafeInteger(next))
    throw new RangeError("Legacy JSON structural representation exhausted");
  return next;
}

function framePosition(depth: number): number {
  const position = (depth - 1) * frameBytes;
  if (
    depth < 1 ||
    !Number.isSafeInteger(position) ||
    !Number.isSafeInteger(position + frameBytes)
  )
    throw new RangeError("Legacy JSON frame position exhausted");
  return position;
}

async function* readTokenRecords(
  source: FileHandle,
  signal: AbortSignal | undefined,
): AsyncGenerator<Buffer> {
  const block = Buffer.alloc(recordBytes);
  const record = Buffer.alloc(recordBytes);
  let position = 0;
  let length = 0;
  for (;;) {
    signal?.throwIfAborted();
    const read = await source.read(block, 0, block.length, position);
    if (read.bytesRead === 0) break;
    position = checkedAdd(position, read.bytesRead);
    let start = 0;
    while (start < read.bytesRead) {
      const found = block.indexOf(10, start);
      const end = found >= 0 && found < read.bytesRead ? found : read.bytesRead;
      const count = end - start;
      if (length + count >= recordBytes)
        throw new LegacyJsonStructureError("invalid_spool");
      block.copy(record, length, start, end);
      length += count;
      if (end < read.bytesRead) {
        if (length === 0) throw new LegacyJsonStructureError("invalid_spool");
        yield record.subarray(0, length);
        length = 0;
      }
      start = end + 1;
    }
  }
  if (length !== 0) throw new LegacyJsonStructureError("invalid_spool");
}
