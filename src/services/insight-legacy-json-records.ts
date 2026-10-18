import type { FileHandle } from "node:fs/promises";
import * as v from "valibot";
import { err, ok, type Result } from "#src/domain/result";

const ordinal = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const identity = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const structureRecordSchema = v.union([
  v.strictObject({
    tag: v.literal("node"),
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
  }),
  v.strictObject({ tag: v.literal("root"), id: identity }),
  v.strictObject({
    tag: v.literal("child"),
    parent: identity,
    id: identity,
    ordinal,
    key: v.nullable(identity),
  }),
  v.strictObject({
    tag: v.literal("fragment"),
    id: identity,
    sequence: ordinal,
    text: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
  }),
  v.strictObject({
    tag: v.literal("scalar_end"),
    id: identity,
    fragments: ordinal,
    codeUnits: ordinal,
  }),
  v.strictObject({
    tag: v.literal("container_end"),
    id: identity,
    children: ordinal,
  }),
]);

/** Private structural records retain decoded code units and every source occurrence. */
export type LegacyJsonStructureRecord = v.InferOutput<
  typeof structureRecordSchema
>;

/** Safe failure categories for bounded private-record reads. */
export type LegacyJsonRecordFailure = {
  readonly _tag: "LegacyJsonRecordFailure";
  readonly reason:
    | "invalid_spool"
    | "storage_unavailable"
    | "representation_exhausted"
    | "cancelled";
};

/** Two persistent 16KiB buffers avoid rereading adjacent records and never assemble complete scalars. */
export class LegacyJsonStructureReader {
  private readonly block = Buffer.alloc(16384);
  private readonly record = Buffer.alloc(16384);
  private position = 0;
  private start = 0;
  private available = 0;

  constructor(
    private readonly source: FileHandle,
    private readonly signal?: AbortSignal,
  ) {}

  /** Reads one closed canonical record at explicit descriptor offsets. */
  async read(): Promise<
    Result<LegacyJsonStructureRecord | null, LegacyJsonRecordFailure>
  > {
    try {
      let length = 0;
      for (;;) {
        this.signal?.throwIfAborted();
        if (this.start === this.available) {
          if (!Number.isSafeInteger(this.position + this.block.length))
            throw new RangeError();
          const read = await this.source.read(
            this.block,
            0,
            this.block.length,
            this.position,
          );
          this.position += read.bytesRead;
          this.start = 0;
          this.available = read.bytesRead;
          if (read.bytesRead === 0) {
            return length === 0
              ? ok(null)
              : err({
                  _tag: "LegacyJsonRecordFailure",
                  reason: "invalid_spool",
                });
          }
        }
        const found = this.block.indexOf(10, this.start);
        const end =
          found >= 0 && found < this.available ? found : this.available;
        const count = end - this.start;
        if (length + count >= this.record.length)
          return err({
            _tag: "LegacyJsonRecordFailure",
            reason: "invalid_spool",
          });
        this.block.copy(this.record, length, this.start, end);
        length += count;
        this.start = end;
        if (end === this.available) continue;
        this.start += 1;
        if (length === 0)
          return err({
            _tag: "LegacyJsonRecordFailure",
            reason: "invalid_spool",
          });
        const bytes = this.record.subarray(0, length);
        let input: unknown;
        try {
          input = JSON.parse(bytes.toString("utf8"));
        } catch {
          return err({
            _tag: "LegacyJsonRecordFailure",
            reason: "invalid_spool",
          });
        }
        const parsed = v.safeParse(structureRecordSchema, input);
        if (
          !parsed.success ||
          !Buffer.from(JSON.stringify(parsed.output)).equals(bytes)
        )
          return err({
            _tag: "LegacyJsonRecordFailure",
            reason: "invalid_spool",
          });
        return ok(parsed.output);
      }
    } catch (cause: unknown) {
      return err({
        _tag: "LegacyJsonRecordFailure",
        reason: this.signal?.aborted
          ? "cancelled"
          : cause instanceof RangeError
            ? "representation_exhausted"
            : "storage_unavailable",
      });
    }
  }
}
