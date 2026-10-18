import type { FileHandle } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { err, ok, type Result } from "#src/domain/result";
import type { LegacyJsonStructure } from "./insight-legacy-json-decoder";
import { LegacyJsonStructureReader } from "./insight-legacy-json-records";

const infinityBits = 0x7ff0000000000000n;
const fractionMask = 0xfffffffffffffn;

type NumberFailure = {
  readonly _tag: "LegacyJsonNumberFailure";
  readonly reason:
    | "invalid_spool"
    | "storage_unavailable"
    | "representation_exhausted"
    | "cancelled";
};
type Decimal = { readonly digits: string; readonly exponent: bigint };
type Dyadic = { readonly coefficient: bigint; readonly exponent: number };

class NumberReadError extends Error {
  constructor(readonly reason: NumberFailure["reason"]) {
    super("Legacy JSON number conversion failed");
  }
}

/** Converts one selected numeric node on the storage-owned descriptor; Infinity is a value, not schema acceptance. */
export async function readLegacyJsonNumber(
  source: FileHandle,
  structure: LegacyJsonStructure,
  nodeId: number,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Result<number, NumberFailure>> {
  try {
    if (
      !Number.isSafeInteger(nodeId) ||
      nodeId < 1 ||
      nodeId > add(structure.values, structure.keys)
    )
      invalid();
    const metadata = await scanNumber(source, structure, nodeId, options);
    let bits = 0n;
    if (metadata.firstNonzero !== -1) {
      let lower = 0n;
      let upper = infinityBits;
      // Positive finite encodings are ordered; the upper sentinel denotes virtual 2^1024.
      while (upper - lower > 1n) {
        const middle = (lower + upper) / 2n;
        const compared = await scanNumber(
          source,
          structure,
          nodeId,
          options,
          metadata,
          decimal(dyadic(middle)),
        );
        if (compared.comparison >= 0) lower = middle;
        else upper = middle;
      }
      const left = dyadic(lower);
      const right = dyadic(upper);
      const exponent = Math.min(left.exponent, right.exponent);
      const midpoint = decimal({
        coefficient:
          (left.coefficient << BigInt(left.exponent - exponent)) +
          (right.coefficient << BigInt(right.exponent - exponent)),
        exponent: exponent - 1,
      });
      const compared = await scanNumber(
        source,
        structure,
        nodeId,
        options,
        metadata,
        midpoint,
      );
      bits =
        compared.comparison > 0 ||
        (compared.comparison === 0 && lower % 2n !== 0n)
          ? upper
          : lower;
    }
    options.signal?.throwIfAborted();
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(bits | (metadata.negative ? 1n << 63n : 0n));
    return ok(bytes.readDoubleBE());
  } catch (cause: unknown) {
    return err({
      _tag: "LegacyJsonNumberFailure",
      reason: options.signal?.aborted
        ? "cancelled"
        : cause instanceof NumberReadError
          ? cause.reason
          : cause instanceof RangeError
            ? "representation_exhausted"
            : "storage_unavailable",
    });
  }
}

async function scanNumber(
  source: FileHandle,
  structure: LegacyJsonStructure,
  nodeId: number,
  options: { readonly signal?: AbortSignal },
  expected?: NumberScan,
  target?: Decimal,
): Promise<NumberScan> {
  await setImmediate(undefined, options);
  const reader = new LegacyJsonStructureReader(source, options.signal);
  const number = new NumberScan(expected, target);
  let active = false;
  let seen = false;
  let ended = false;
  let attached = false;
  let rootSeen = false;
  let nodes = 0;
  let records = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    const result = await reader.read();
    if (result._tag === "err") throw new NumberReadError(result.error.reason);
    const record = result.value;
    if (record === null) break;
    records = add(records, 1);
    if (records % 64 === 0) await setImmediate(undefined, options);
    if (record.tag === "node") {
      if (active) invalid();
      nodes = add(nodes, 1);
      if (record.id !== nodes) invalid();
      if (record.id === nodeId) {
        if (seen || record.kind !== "number") invalid();
        active = true;
        seen = true;
      }
    } else if (record.tag === "fragment" && record.id === nodeId) {
      if (!active || record.sequence !== number.fragments) invalid();
      number.fragments = add(number.fragments, 1);
      number.units = add(number.units, record.text.length);
      for (let i = 0; i < record.text.length; i += 1)
        number.consume(record.text.charAt(i));
    } else if (record.tag === "scalar_end" && record.id === nodeId) {
      if (
        !active ||
        record.fragments !== number.fragments ||
        record.codeUnits !== number.units
      )
        invalid();
      number.finish();
      active = false;
      ended = true;
    } else if (record.tag === "child" && active) {
      if (attached || number.fragments !== 0 || record.id !== nodeId) invalid();
      attached = true;
    } else if (record.tag === "root") {
      if (active || rootSeen || record.id !== structure.root) invalid();
      rootSeen = true;
    } else if (active) invalid();
  }
  if (
    active ||
    !ended ||
    !attached ||
    !rootSeen ||
    records !== structure.records ||
    nodes !== add(structure.values, structure.keys)
  )
    invalid();
  options.signal?.throwIfAborted();
  return number;
}

class NumberScan {
  negative = false;
  digits = 0;
  fraction = 0;
  firstNonzero = -1;
  exponent = 0;
  exponentNegative = false;
  fragments = 0;
  units = 0;
  comparison = 0;
  private state:
    | "start"
    | "minus"
    | "zero"
    | "integer"
    | "dot"
    | "fraction"
    | "exponent"
    | "exponent_sign"
    | "exponent_digits" = "start";

  constructor(
    private readonly expected?: NumberScan,
    private readonly target?: Decimal,
  ) {
    if (expected !== undefined && target !== undefined) {
      const scale =
        BigInt(
          expected.exponentNegative ? -expected.exponent : expected.exponent,
        ) - BigInt(expected.fraction);
      const scientific =
        BigInt(expected.digits) - BigInt(expected.firstNonzero) - 1n + scale;
      this.comparison =
        scientific < target.exponent
          ? -1
          : scientific > target.exponent
            ? 1
            : 0;
    }
  }

  consume(character: string): void {
    const digit = character.charCodeAt(0) - 48;
    const isDigit = digit >= 0 && digit <= 9;
    switch (this.state) {
      case "start":
        if (character === "-") {
          this.negative = true;
          this.state = "minus";
          return;
        }
        this.beginInteger(digit, isDigit);
        return;
      case "minus":
        this.beginInteger(digit, isDigit);
        return;
      case "zero":
      case "integer":
        if (isDigit && this.state === "integer") this.mantissaDigit(digit);
        else if (character === ".") this.state = "dot";
        else if (character === "e" || character === "E")
          this.state = "exponent";
        else invalid();
        return;
      case "dot":
        if (!isDigit) invalid();
        this.state = "fraction";
        this.mantissaDigit(digit);
        return;
      case "fraction":
        if (isDigit) this.mantissaDigit(digit);
        else if (character === "e" || character === "E")
          this.state = "exponent";
        else invalid();
        return;
      case "exponent":
        if (character === "+" || character === "-") {
          this.exponentNegative = character === "-";
          this.state = "exponent_sign";
          return;
        }
        this.exponentDigit(digit, isDigit);
        return;
      case "exponent_sign":
      case "exponent_digits":
        this.exponentDigit(digit, isDigit);
    }
  }

  finish(): void {
    if (
      this.state !== "zero" &&
      this.state !== "integer" &&
      this.state !== "fraction" &&
      this.state !== "exponent_digits"
    )
      invalid();
    const expected = this.expected;
    if (
      expected !== undefined &&
      (this.negative !== expected.negative ||
        this.digits !== expected.digits ||
        this.fraction !== expected.fraction ||
        this.firstNonzero !== expected.firstNonzero ||
        this.exponent !== expected.exponent ||
        this.exponentNegative !== expected.exponentNegative ||
        this.fragments !== expected.fragments ||
        this.units !== expected.units)
    )
      invalid();
    const target = this.target;
    if (target !== undefined && this.comparison === 0) {
      const significant = this.digits - this.firstNonzero;
      for (let i = significant; i < target.digits.length; i += 1)
        if (target.digits.charAt(i) !== "0") {
          this.comparison = -1;
          break;
        }
    }
  }

  private beginInteger(digit: number, isDigit: boolean): void {
    if (!isDigit) invalid();
    this.state = digit === 0 ? "zero" : "integer";
    this.mantissaDigit(digit);
  }

  private mantissaDigit(digit: number): void {
    if (this.firstNonzero === -1 && digit !== 0)
      this.firstNonzero = this.digits;
    const position = this.digits - this.firstNonzero;
    const target = this.target;
    if (
      this.firstNonzero !== -1 &&
      target !== undefined &&
      this.comparison === 0
    ) {
      const other =
        position < target.digits.length
          ? target.digits.charCodeAt(position) - 48
          : 0;
      if (digit !== other) this.comparison = digit < other ? -1 : 1;
    }
    this.digits = add(this.digits, 1);
    if (this.state === "fraction") this.fraction = add(this.fraction, 1);
  }

  private exponentDigit(digit: number, isDigit: boolean): void {
    if (!isDigit) invalid();
    // fast_float cfd12eb's strict threshold retains up to 10*2^28-1, not a clamp or signed int32.
    if (this.exponent < 268435456) this.exponent = 10 * this.exponent + digit;
    this.state = "exponent_digits";
  }
}

function dyadic(bits: bigint): Dyadic {
  const biased = Number(bits >> 52n);
  return biased === 0
    ? { coefficient: bits, exponent: -1074 }
    : {
        coefficient: (1n << 52n) + (bits & fractionMask),
        exponent: biased - 1075,
      };
}

function decimal(value: Dyadic): Decimal {
  // Candidates/midpoints have <=54 coefficient bits and exponent >=-1075: numerator <2^2551, <=768 digits.
  const places = Math.max(0, -value.exponent);
  let numerator = value.coefficient;
  for (let i = 0; i < places; i += 1) numerator *= 5n;
  if (places === 0) numerator <<= BigInt(value.exponent);
  const digits = numerator.toString(10);
  return { digits, exponent: BigInt(digits.length - places - 1) };
}

function invalid(): never {
  throw new NumberReadError("invalid_spool");
}

function add(value: number, delta: number): number {
  const next = value + delta;
  if (!Number.isSafeInteger(next))
    throw new RangeError("Legacy JSON numeric representation exhausted");
  return next;
}
