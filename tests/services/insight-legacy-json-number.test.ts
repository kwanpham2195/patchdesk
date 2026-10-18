import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  LegacyJsonIndexRow,
  LegacyJsonPropertyRecord,
} from "#src/adapters/storage/insight-legacy-json-index-store";
import { parseInsightRecord } from "#src/adapters/storage/insight-store";
import { containsSensitiveData } from "#src/adapters/storage/json-file";
import { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { parseReviewId, parseWorkspaceProfileId } from "#src/domain/ids";
import { readLegacyJsonNumber } from "#src/services/insight-legacy-json-number";
import type { LegacyJsonStructureRecord } from "#src/services/insight-legacy-json-records";
import { InsightMigrationService } from "#src/services/insight-migration-service";

const reviewText =
  "github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa";
const timestamp = "2026-08-01T00:01:00.000Z";
const base =
  '{"schemaVersion":2,"reviewId":"' +
  reviewText +
  '","type":"analysis","nextToken":1,"updatedAt":"' +
  timestamp +
  '"}';
const profile = parseWorkspaceProfileId("acme");
const review = parseReviewId(reviewText);
if (profile._tag === "err" || review._tag === "err")
  throw new Error("Invalid numeric fixture IDs");
const profileId = profile.value;
const reviewId = review.value;
const halfMinimum = (5n ** 1075n).toString();
const overflowBoundary = (2n ** 54n - 1n) * 2n ** 970n;
const versionMidpoint =
  "2.0000000000000002220446049250313080847263336181640625";
const cases = [
  ["P1 unsafe integer tie down", "9007199254740993", "4340000000000000", true],
  [
    "P2 even version and unsafe integer tie up",
    "9007199254740995",
    "4340000000000002",
    true,
  ],
  [
    "P3 late nonzero above midpoint",
    "1.00000000000000011102230246251565404236316680908203125" +
      "0".repeat(2048) +
      "1",
    "3ff0000000000001",
    false,
  ],
  ["P4 negative zero", "-0", "8000000000000000", false],
  ["P5 signed nonzero underflow", "-1e-400", "8000000000000000", false],
  [
    "P6 exact minimum-subnormal midpoint",
    halfMinimum + "e-1075",
    "0000000000000000",
    false,
  ],
  [
    "P7 above minimum-subnormal midpoint",
    halfMinimum + "1e-1076",
    "0000000000000001",
    false,
  ],
  [
    "P8 below overflow midpoint",
    (overflowBoundary - 1n).toString(),
    "7fefffffffffffff",
    true,
  ],
  [
    "P9 exact overflow midpoint",
    overflowBoundary.toString(),
    "7ff0000000000000",
    false,
  ],
  ["P10 negative overflow", "-1e999", "fff0000000000000", false],
  ["P11 negative finite fraction", "-1.5", "bff8000000000000", false],
  [
    "P12 fractional prefix scale",
    "0." + "0".repeat(2048) + "1000" + "0".repeat(32) + "e+2052",
    "408f400000000000",
    true,
  ],
  [
    "P13 integer prefix scale",
    "1000" + "0".repeat(2048) + "e-2048",
    "408f400000000000",
    true,
  ],
  [
    "P14 exponent leading zeros",
    "1e-" + "0".repeat(2050),
    "3ff0000000000000",
    true,
  ],
  [
    "P15 selected duplicates and ignored infinity",
    "1",
    "3ff0000000000000",
    true,
  ],
] as const;
let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("InsightMigrationService selected root numeric acceptance", () => {
  it.each(cases)("%s", async (label, token, expectedBits, checked) => {
    const versionToken = label.startsWith("P2 ") ? versionMidpoint : "2";
    let raw = base
      .replace('"nextToken":1', '"nextToken":' + token)
      .replace('"schemaVersion":2', '"schemaVersion":' + versionToken);
    const duplicates = label.startsWith("P15 ");
    if (duplicates)
      raw =
        '{"schemaVersion":1,"nextToken":-1,' +
        base.slice(1, -1) +
        ',"retained":{"value":1e999}}';
    root = await mkdtemp(
      join(await realpath(tmpdir()), "patchdesk-root-numeric-"),
    );
    const paths = PatchdeskPaths.forTest(root);
    const source = paths.insightFile(profileId, reviewId, "analysis");
    const original = Buffer.from(raw);
    expect(original.length).toBeLessThanOrEqual(4096);
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, original);
    // This is the host Node oracle; the separately captured native Electron proof is not rerun here.
    const host: unknown = JSON.parse(raw);
    expect(containsSensitiveData(host)).toBe(false);
    const oldRecord = parseInsightRecord(host);
    expect(
      oldRecord._tag === "ok" &&
        oldRecord.value.reviewId === reviewId &&
        oldRecord.value.type === "analysis",
    ).toBe(checked && !duplicates);
    const result = await new InsightMigrationService(
      paths,
    ).prepareAnalysisShadow(profileId, reviewId);
    const attempts = await readdir(
      paths.insightMigrationDirectory(profileId, reviewId),
    );
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0];
    if (attempt === undefined)
      throw new Error("Missing numeric fixture attempt");
    const scratch = join(
      paths.insightMigrationDirectory(profileId, reviewId),
      attempt,
    );
    const backup = await readFile(join(scratch, "source.json"));
    expect(await readFile(source)).toEqual(original);
    expect(backup).toEqual(original);
    expect(createHash("sha256").update(backup).digest("hex")).toBe(
      createHash("sha256").update(original).digest("hex"),
    );
    const records: ReadonlyArray<LegacyJsonStructureRecord> = (
      await readFile(join(scratch, "structure.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const properties: ReadonlyArray<LegacyJsonPropertyRecord> = (
      await readFile(join(scratch, "properties.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const bytes = await readFile(join(scratch, "nodes.bin"));
    const keys = await readFile(join(scratch, "keys.utf16le"));
    const nodes: LegacyJsonIndexRow[] = [];
    for (let offset = 0; offset < bytes.length; offset += 1024) {
      const row: LegacyJsonIndexRow = JSON.parse(
        bytes
          .subarray(offset + 4, offset + 4 + bytes.readUInt32LE(offset))
          .toString("utf8"),
      );
      nodes.push(row);
    }
    const edges = properties
      .filter((row) => row.tag === "child")
      .filter((row) => row.parent === 1);
    let depth = 0;
    let maxDepth = 0;
    for (const record of records) {
      if (
        record.tag === "node" &&
        (record.kind === "object" || record.kind === "array")
      )
        maxDepth = Math.max(maxDepth, ++depth);
      if (record.tag === "container_end") depth -= 1;
    }
    expect(depth).toBe(0);
    const structure = {
      root: 1,
      values: nodes.filter((row) => row.kind !== "key").length,
      keys: nodes.filter((row) => row.kind === "key").length,
      records: records.length,
      maxDepth,
    };
    const handle = await open(join(scratch, "structure.ndjson"), "r");
    try {
      for (const [name, text, hexadecimal] of [
        ["schemaVersion", versionToken, "4000000000000000"],
        ["nextToken", token, expectedBits],
      ] as const) {
        const edge = edges.find((row) => {
          const key = nodes.find((node) => node.id === row.key);
          return (
            key !== undefined &&
            keys
              .subarray(key.keyOffset, key.keyOffset + key.keyBytes)
              .toString("utf16le") === name
          );
        });
        if (edge === undefined)
          throw new Error("Missing selected numeric fixture edge");
        const node = nodes.find((row) => row.id === edge.id);
        const key = nodes.find((row) => row.id === edge.key);
        expect(node).toMatchObject({
          kind: "number",
          selected: true,
          reachable: true,
          parent: 1,
        });
        expect(key?.value).toBe(edge.id);
        const fragments = records
          .filter((row) => row.tag === "fragment")
          .filter((row) => row.id === edge.id);
        expect(fragments.map((row) => row.text).join("")).toBe(text);
        expect(fragments.map((row) => row.text.length)).toEqual(
          Array.from({ length: Math.ceil(text.length / 2048) }, (_, i) =>
            Math.min(2048, text.length - i * 2048),
          ),
        );
        expect(fragments.map((row) => row.sequence)).toEqual(
          fragments.map((_, i) => i),
        );
        expect(
          records.find((row) => row.tag === "scalar_end" && row.id === edge.id),
        ).toEqual({
          tag: "scalar_end",
          id: edge.id,
          fragments: fragments.length,
          codeUnits: text.length,
        });
        const value = await readLegacyJsonNumber(handle, structure, edge.id);
        if (value._tag === "err")
          throw new Error("Numeric fixture conversion failed");
        const bits = Buffer.alloc(8);
        bits.writeDoubleBE(value.value);
        expect(bits.toString("hex")).toBe(hexadecimal);
      }
    } finally {
      await handle.close();
    }
    if (checked)
      expect(result).toMatchObject({
        _tag: "ok",
        value: {
          state: "analysis_root_numbers_checked",
          pending: "nested_schema_numeric_conversion_equality",
          sourceBytes: original.length,
          sourceHash: createHash("sha256").update(original).digest("hex"),
          structure,
        },
      });
    else
      expect(result).toEqual({
        _tag: "err",
        error: { _tag: "AnalysisShadowFailure", reason: "invalid_legacy" },
      });
    if (duplicates) {
      const scalars = nodes
        .filter((row) => row.kind === "number")
        .map((row) => [
          records
            .filter((record) => record.tag === "fragment")
            .filter((record) => record.id === row.id)
            .map((record) => record.text)
            .join(""),
          row.selected,
          row.reachable,
        ]);
      expect(scalars).toEqual([
        ["1", false, false],
        ["-1", false, false],
        ["2", true, true],
        ["1", true, true],
        ["1e999", true, true],
      ]);
      expect(edges.find((row) => row.key === 2)).toMatchObject({
        id: 7,
        lastKey: 6,
        firstOrdinal: 0,
      });
      expect(edges.find((row) => row.key === 4)).toMatchObject({
        id: 13,
        lastKey: 12,
        firstOrdinal: 1,
      });
    }
  });
});
