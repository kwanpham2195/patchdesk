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
import type { LegacyJsonIndexRow } from "#src/adapters/storage/insight-legacy-json-index-store";
import { containsSensitiveData } from "#src/adapters/storage/json-file";
import { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { parseReviewId, parseWorkspaceProfileId } from "#src/domain/ids";
import type { LegacyJsonStructureRecord } from "#src/services/insight-legacy-json-records";
import { InsightMigrationService } from "#src/services/insight-migration-service";

const profile = parseWorkspaceProfileId("acme");
const review = parseReviewId(
  "github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
);
if (profile._tag === "err" || review._tag === "err")
  throw new Error("Invalid sensitive scan fixture IDs");
const profileId = profile.value;
const reviewId = review.value;
let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("InsightMigrationService resulting-value sensitive scan", () => {
  it("separates key and value policies and excludes overwritten sensitive data", async () => {
    const fixture = await prepare(
      '{"ghp_' +
        "a".repeat(20) +
        '":"password","drop":{"password":0},"dr\\u006fp":false,' +
        '"dup":"ghp_' +
        "a".repeat(20) +
        '","dup":null,"ignored":["secret","authorization","cookie",' +
        '"GHP_' +
        "a".repeat(20) +
        '","ghp_' +
        "a".repeat(19) +
        '","github_pat_' +
        "a".repeat(19) +
        '","glpat-' +
        "a".repeat(19) +
        '","xoxb-' +
        "a".repeat(19) +
        '"],"\\uD800":true}',
      false,
    );
    const staleName = fixture.structure.find(
      (row) =>
        row.tag === "fragment" &&
        row.text === "password" &&
        fixture.nodes.get(row.id)?.kind === "key",
    );
    if (staleName === undefined) throw new Error("Missing stale key");
    const edge = fixture.structure.find(
      (row) => row.tag === "child" && row.key === staleName.id,
    );
    if (edge?.tag !== "child") throw new Error("Missing stale edge");
    expect(fixture.nodes.get(edge.parent)?.reachable).toBe(false);
    expect(fixture.nodes.get(edge.id)?.reachable).toBe(false);
    const staleValue = fixture.structure.find(
      (row) => row.tag === "fragment" && row.text === "ghp_" + "a".repeat(20),
    );
    if (staleValue === undefined) throw new Error("Missing stale value");
    expect(fixture.nodes.get(staleValue.id)?.reachable).toBe(false);
    expect(
      fixture.structure.some(
        (row) => row.tag === "fragment" && row.text === "\uD800",
      ),
    ).toBe(true);
  });

  it("rejects a selected escaped mixed-case sensitive key across fragments", async () => {
    const fixture = await prepare(
      "{" + '"\\uD800' + "x".repeat(2044) + 'AuTh\\u004FrIzAtIoN":false}',
      true,
    );
    expectScalar(
      fixture.structure,
      "\uD800" + "x".repeat(2044) + "AuThOrIzAtIoN",
    );
  });

  it("rejects a GitHub short token in an ignored array across fragments", async () => {
    const text = "x".repeat(2046) + "ghp_" + "a".repeat(20);
    const fixture = await prepare(JSON.stringify({ ignored: [text] }), true);
    expectScalar(fixture.structure, text);
  });

  it("rejects a GitHub PAT with underscore token units across fragments", async () => {
    const text = "x".repeat(2046) + "github_pat_" + "_".repeat(20);
    const fixture = await prepare(JSON.stringify({ ignored: [text] }), true);
    expectScalar(fixture.structure, text);
  });

  it("rejects a GitLab token with hyphen units across fragments", async () => {
    const text = "x".repeat(2046) + "glpat-" + "-".repeat(20);
    const fixture = await prepare(JSON.stringify({ ignored: [text] }), true);
    expectScalar(fixture.structure, text);
  });

  it("rejects a Slack token with hyphen units across fragments", async () => {
    const text = "x".repeat(2046) + "xoxb-" + "-".repeat(20);
    const fixture = await prepare(JSON.stringify({ ignored: [text] }), true);
    expectScalar(fixture.structure, text);
  });

  it("rejects Bearer with long FEFF whitespace and a nonword-to-word boundary", async () => {
    const text =
      "\uD800" +
      "x".repeat(2044) +
      " Bearer" +
      "\uFEFF".repeat(4096) +
      "-".repeat(4096) +
      "a!";
    const fixture = await prepare(JSON.stringify({ ignored: text }), true);
    expectScalar(fixture.structure, text);
  });

  it("rejects long JWT segments with the final boundary at true scalar EOF", async () => {
    const text =
      "\uD800" +
      "x".repeat(2044) +
      " eyJ" +
      "a".repeat(4096) +
      "." +
      "a".repeat(4096) +
      "." +
      "a".repeat(4096);
    const fixture = await prepare(JSON.stringify({ ignored: text }), true);
    expectScalar(fixture.structure, text);
  });

  it("accepts the approved Bearer boundary, whitespace and minimum controls", async () => {
    await prepare(
      JSON.stringify({
        ignored: [
          "Bearer " + "-".repeat(4096),
          "_Bearer " + "a".repeat(4096),
          "Bearer\u0085" + "a".repeat(4096),
          "Bearer " + "a".repeat(15),
        ],
      }),
      false,
    );
  });

  it("accepts the approved JWT boundary and segment-minimum controls", async () => {
    await prepare(
      JSON.stringify({
        ignored: [
          "eyJ" +
            "a".repeat(10) +
            "." +
            "a".repeat(10) +
            "." +
            "-".repeat(4096),
          "_eyJ" +
            "a".repeat(10) +
            "." +
            "a".repeat(10) +
            "." +
            "a".repeat(4096),
          "eyJ" + "a".repeat(9) + "." + "a".repeat(10) + "." + "a".repeat(10),
          "eyJ" + "a".repeat(10) + "." + "a".repeat(9) + "." + "a".repeat(10),
          "eyJ" + "a".repeat(10) + "." + "a".repeat(10) + "." + "a".repeat(9),
        ],
      }),
      false,
    );
  });
});

async function prepare(text: string, sensitive: boolean) {
  root = await mkdtemp(join(await realpath(tmpdir()), "patchdesk-sensitive-"));
  const paths = PatchdeskPaths.forTest(root);
  const source = paths.insightFile(profileId, reviewId, "analysis");
  const original = Buffer.from(text);
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, original);
  expect(containsSensitiveData(JSON.parse(text))).toBe(sensitive);
  const result = await new InsightMigrationService(paths).prepareAnalysisShadow(
    profileId,
    reviewId,
  );
  if (sensitive)
    expect(result).toEqual({
      _tag: "err",
      error: { _tag: "AnalysisShadowFailure", reason: "sensitive_value" },
    });
  else
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        state: "sensitive_checked",
        pending: "schema_conversion_equality",
      },
    });
  const directory = paths.insightMigrationDirectory(profileId, reviewId);
  const attempts = await readdir(directory);
  expect(attempts).toHaveLength(1);
  const attempt = attempts[0];
  if (attempt === undefined) throw new Error("Missing sensitive scan backup");
  const scratch = join(directory, attempt);
  const backup = await readFile(join(scratch, "source.json"));
  expect(await readFile(source)).toEqual(original);
  expect(backup).toEqual(original);
  expect(createHash("sha256").update(backup).digest("hex")).toBe(
    createHash("sha256").update(original).digest("hex"),
  );
  const structure: ReadonlyArray<LegacyJsonStructureRecord> = (
    await readFile(join(scratch, "structure.ndjson"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line: string) => JSON.parse(line));
  const bytes = await readFile(join(scratch, "nodes.bin"));
  const nodes = new Map<number, LegacyJsonIndexRow>();
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    const row: LegacyJsonIndexRow = JSON.parse(
      bytes
        .subarray(offset + 4, offset + 4 + bytes.readUInt32LE(offset))
        .toString("utf8"),
    );
    nodes.set(row.id, row);
  }
  return { structure, nodes };
}

function expectScalar(
  structure: ReadonlyArray<LegacyJsonStructureRecord>,
  text: string,
) {
  const first = structure.find(
    (row) => row.tag === "fragment" && row.text === text.slice(0, 2048),
  );
  if (first === undefined) throw new Error("Missing first scalar fragment");
  const fragments = structure.filter(
    (row) => row.tag === "fragment" && row.id === first.id,
  );
  expect(
    fragments.map((row) => (row.tag === "fragment" ? row.text : "")).join(""),
  ).toBe(text);
  expect(fragments).toHaveLength(Math.ceil(text.length / 2048));
  expect(
    structure.find((row) => row.tag === "scalar_end" && row.id === first.id),
  ).toEqual({
    tag: "scalar_end",
    id: first.id,
    fragments: fragments.length,
    codeUnits: text.length,
  });
}
