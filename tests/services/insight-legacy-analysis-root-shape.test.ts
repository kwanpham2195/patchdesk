import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
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
  throw new Error("Invalid root fixture IDs");
const profileId = profile.value;
const reviewId = review.value;
let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("InsightMigrationService selected Analysis root", () => {
  it("checks the current empty Analysis root without claiming full conversion", async () => {
    const fixture = await prepare(base, true, true);
    expect(fixture.rootEdges.map((edge) => [edge.name, edge.kind])).toEqual([
      ["schemaVersion", "number"],
      ["reviewId", "string"],
      ["type", "string"],
      ["nextToken", "number"],
      ["updatedAt", "string"],
    ]);
  });

  it("checks all optional root kinds while nested and cross-field acceptance remains pending", async () => {
    const fixture = await prepare(
      append(
        ',"retained":{},"dismissals":[],"walkthroughProgress":{},"guideReadingState":{},"analysisVerification":{},"replacementFailure":{},"activeRun":{}',
      ),
      true,
      false,
    );
    expect(
      fixture.rootEdges.slice(5).map((edge) => [edge.name, edge.kind]),
    ).toEqual([
      ["retained", "object"],
      ["dismissals", "array"],
      ["walkthroughProgress", "object"],
      ["guideReadingState", "object"],
      ["analysisVerification", "object"],
      ["replacementFailure", "object"],
      ["activeRun", "object"],
    ]);
  });

  it("rejects invalid version literal and next-token numeric semantics", async () => {
    await prepare(
      base
        .replace('"schemaVersion":2', '"schemaVersion":1')
        .replace('"nextToken":1', '"nextToken":-0.5'),
      false,
      false,
    );
  });

  it("uses the last review identity and excludes its overwritten long value", async () => {
    const fixture = await prepare(
      '{"reviewId":"' + "x".repeat(4097) + '",' + base.slice(1),
      true,
      true,
    );
    expect(fixture.rootEdges[0]).toMatchObject({
      name: "reviewId",
      key: 2,
      id: 7,
      lastKey: 6,
      firstOrdinal: 0,
    });
    expect(fixture.nodes.get(3)).toMatchObject({
      kind: "string",
      selected: false,
      reachable: false,
    });
    expectScalar(fixture.structure, 3, "x".repeat(4097), [2048, 2048, 1]);
  });

  it("rejects a surviving unknown name even when its old subtree was overwritten", async () => {
    const fixture = await prepare(
      append(',"extra":{"old":0},"extra":0'),
      false,
      false,
    );
    expect(fixture.rootEdges[5]).toMatchObject({
      name: "extra",
      key: 12,
      id: 17,
      lastKey: 16,
      firstOrdinal: 5,
    });
    expect(fixture.nodes.get(13)).toMatchObject({
      kind: "object",
      selected: false,
      reachable: false,
    });
    expect(fixture.nodes.get(15)).toMatchObject({
      kind: "number",
      parent: 13,
      reachable: false,
    });
  });

  it("rejects an unknown name with an exact lone-surrogate suffix", async () => {
    const fixture = await prepare(append(',"reviewId\\uD800":0'), false, false);
    const edge = fixture.rootEdges[5];
    expect(edge).toMatchObject({ name: "reviewId\uD800", key: 12, id: 13 });
    const key = fixture.nodes.get(12);
    if (key === undefined) throw new Error("Missing surrogate fixture key");
    expect(
      fixture.keys
        .subarray(key.keyOffset, key.keyOffset + key.keyBytes)
        .toString("hex"),
    ).toBe("7200650076006900650077004900640000d8");
  });

  it("rejects a fragmented long name rather than matching its accepted prefix", async () => {
    const name = "updatedAt" + "x".repeat(2049);
    const fixture = await prepare(append(',"' + name + '":0'), false, false);
    expect(fixture.rootEdges[5]).toMatchObject({ name, key: 12, id: 13 });
    expectScalar(fixture.structure, 12, name, [2048, 10]);
  });

  it("rejects a root missing its required timestamp", async () => {
    const fixture = await prepare(
      base.replace(',"updatedAt":"' + timestamp + '"', ""),
      false,
      false,
    );
    expect(fixture.rootEdges.map((edge) => edge.name)).toEqual([
      "schemaVersion",
      "reviewId",
      "type",
      "nextToken",
    ]);
  });

  it("rejects a string schema version before numeric conversion", async () => {
    await prepare(
      base.replace('"schemaVersion":2', '"schemaVersion":"2"'),
      false,
      false,
    );
  });

  it("rejects a string next token before numeric conversion", async () => {
    await prepare(
      base.replace('"nextToken":1', '"nextToken":"1"'),
      false,
      false,
    );
  });

  it("rejects a different valid stored Review ID", async () => {
    await prepare(base.replace("pr-42", "pr-43"), false, false);
  });

  it("rejects a Brief record in the requested Analysis slot", async () => {
    await prepare(
      base.replace('"type":"analysis"', '"type":"brief"'),
      false,
      false,
    );
  });

  it("rejects a timestamp that passes domain syntax but fails Valibot", async () => {
    await prepare(
      base.replace(timestamp, "2026-00-01T00:01:00.000Z"),
      false,
      false,
    );
  });

  it("rejects a timestamp that passes Valibot but fails domain syntax", async () => {
    await prepare(
      base.replace(timestamp, "2026-08-01T00:01:00Z"),
      false,
      false,
    );
  });

  it("rejects an array root", async () => {
    const fixture = await prepare("[]", false, false);
    expect(fixture.nodes.get(1)?.kind).toBe("array");
    expect(fixture.rootEdges).toEqual([]);
  });

  it("rejects object dismissals instead of an array", async () => {
    await prepare(append(',"dismissals":{}'), false, false);
  });

  it("rejects array retained state instead of an object", async () => {
    await prepare(append(',"retained":[]'), false, false);
  });
});

function append(suffix: string) {
  return base.slice(0, -1) + suffix + "}";
}

async function prepare(raw: string, checked: boolean, fullAccepted: boolean) {
  root = await mkdtemp(
    join(await realpath(tmpdir()), "patchdesk-root-record-"),
  );
  const paths = PatchdeskPaths.forTest(root);
  const source = paths.insightFile(profileId, reviewId, "analysis");
  const original = Buffer.from(raw);
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, original);
  const input: unknown = JSON.parse(raw);
  expect(containsSensitiveData(input)).toBe(false);
  const parsed = parseInsightRecord(input);
  expect(
    parsed._tag === "ok" &&
      parsed.value.reviewId === reviewId &&
      parsed.value.type === "analysis",
  ).toBe(fullAccepted);
  const result = await new InsightMigrationService(paths).prepareAnalysisShadow(
    profileId,
    reviewId,
  );
  if (checked) {
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        state: "analysis_root_numbers_checked",
        pending: "nested_schema_numeric_conversion_equality",
        sourceHash: createHash("sha256").update(original).digest("hex"),
        sourceBytes: original.length,
        spool: {
          sourceHash: createHash("sha256").update(original).digest("hex"),
          sourceBytes: original.length,
        },
        structure: { root: 1 },
        properties: { root: 1, indexRowBytes: 1024 },
      },
    });
  } else
    expect(result).toEqual({
      _tag: "err",
      error: { _tag: "AnalysisShadowFailure", reason: "invalid_legacy" },
    });
  const migration = paths.insightMigrationDirectory(profileId, reviewId);
  const attempts = await readdir(migration);
  expect(attempts).toHaveLength(1);
  const attempt = attempts[0];
  if (attempt === undefined) throw new Error("Missing root fixture attempt");
  const scratch = join(migration, attempt);
  const backup = await readFile(join(scratch, "source.json"));
  expect(await readFile(source)).toEqual(original);
  expect(backup).toEqual(original);
  expect(createHash("sha256").update(backup).digest("hex")).toBe(
    createHash("sha256").update(original).digest("hex"),
  );
  const bytes = await readFile(join(scratch, "nodes.bin"));
  const keys = await readFile(join(scratch, "keys.utf16le"));
  const nodes = new Map<number, LegacyJsonIndexRow>();
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    const row: LegacyJsonIndexRow = JSON.parse(
      bytes
        .subarray(offset + 4, offset + 4 + bytes.readUInt32LE(offset))
        .toString("utf8"),
    );
    nodes.set(row.id, row);
  }
  const properties: ReadonlyArray<LegacyJsonPropertyRecord> = (
    await readFile(join(scratch, "properties.ndjson"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const structure: ReadonlyArray<LegacyJsonStructureRecord> = (
    await readFile(join(scratch, "structure.ndjson"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const rootEdges = properties
    .filter((row) => row.tag === "child")
    .filter((row) => row.parent === 1)
    .map((edge) => {
      const key = edge.key === null ? undefined : nodes.get(edge.key);
      const value = nodes.get(edge.id);
      if (key === undefined || value === undefined)
        throw new Error("Missing root fixture edge");
      expect(value.selected).toBe(true);
      expect(value.reachable).toBe(true);
      expect(key.value).toBe(edge.id);
      return {
        ...edge,
        name: keys
          .subarray(key.keyOffset, key.keyOffset + key.keyBytes)
          .toString("utf16le"),
        kind: value.kind,
      };
    });
  return { nodes, keys, structure, rootEdges };
}

function expectScalar(
  structure: ReadonlyArray<LegacyJsonStructureRecord>,
  id: number,
  text: string,
  lengths: ReadonlyArray<number>,
) {
  const fragments = structure
    .filter((row) => row.tag === "fragment")
    .filter((row) => row.id === id);
  expect(fragments.map((row) => row.text).join("")).toBe(text);
  expect(fragments.map((row) => row.text.length)).toEqual(lengths);
  expect(fragments.map((row) => row.sequence)).toEqual(
    lengths.map((_length, index) => index),
  );
  expect(
    structure.find((row) => row.tag === "scalar_end" && row.id === id),
  ).toEqual({
    tag: "scalar_end",
    id,
    fragments: lengths.length,
    codeUnits: text.length,
  });
}
