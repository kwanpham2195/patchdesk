import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  open,
  lstat,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import filesystem from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { URL } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  InsightStore,
  parseInsightRecord,
} from "#src/adapters/storage/insight-store";
import { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { isPathContained } from "#src/adapters/storage/path-containment";
import { InsightMigrationService } from "#src/services/insight-migration-service";
import type { LegacyJsonToken } from "#src/services/insight-legacy-json-tokenizer";
import {
  parseIsoTimestamp,
  parseReviewId,
  parseWorkspaceProfileId,
} from "#src/domain/ids";
import {
  beginInsightRun,
  setAnalysisVerificationStep,
} from "#src/domain/insight-record";

const currentRecord = {
  schemaVersion: 2 as const,
  reviewId: "github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
  type: "walkthrough" as const,
  nextToken: 3,
  retained: {
    runId:
      "insight-walkthrough-2-aaaaaaaaaaaa-github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
    revision: {
      sessionId:
        "github.com__octo-org__patchdesk__pr-42__sha-aaaaaaaa__base-00000000__b48f8e2e76ca",
      headSha: "a".repeat(40),
      patchHash: "b".repeat(64),
    },
    generatedAt: "2026-08-01T00:00:00.000Z",
    provenance: {
      provider: "pi" as const,
      model: "model",
      reasoning: "medium" as const,
      language: "en" as const,
    },
    value: { title: "Walkthrough" },
  },
  walkthroughProgress: {
    reviewedSectionIds: ["section-1", "section-2"],
    supportReviewed: true,
    currentSectionId: "section-2",
  },
  replacementFailure: {
    runId:
      "insight-walkthrough-1-aaaaaaaaaaaa-github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
    reason: "failed" as const,
    category: "execution_failed" as const,
    provider: "pi" as const,
    model: "model",
    reasoning: "medium" as const,
    retryable: true,
    failedAt: "2026-07-31T00:00:00.000Z",
  },
  updatedAt: "2026-08-01T00:01:00.000Z",
};

describe("InsightStore schema", () => {
  it("rejects schema 1 records", () => {
    expect(parseInsightRecord({ schemaVersion: 1 })._tag).toBe("err");
  });
  it("round-trips every current schema-2 retained and progress field", () => {
    expect(parseInsightRecord(currentRecord)).toEqual({
      _tag: "ok",
      value: currentRecord,
    });
  });

  it("accepts both existing runtime failures and the new worktree category", () => {
    const runtimeRecord = {
      ...currentRecord,
      replacementFailure: {
        ...currentRecord.replacementFailure,
        category: "runtime_unavailable" as const,
      },
    };
    const worktreeRecord = {
      ...currentRecord,
      replacementFailure: {
        ...currentRecord.replacementFailure,
        category: "review_worktree_unavailable" as const,
      },
    };

    expect(parseInsightRecord(runtimeRecord)).toEqual({
      _tag: "ok",
      value: runtimeRecord,
    });
    expect(parseInsightRecord(worktreeRecord)).toEqual({
      _tag: "ok",
      value: worktreeRecord,
    });
  });

  it("round-trips a Brief record", () => {
    const briefRecord = {
      schemaVersion: 2 as const,
      reviewId: "github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
      type: "brief" as const,
      nextToken: 2,
      retained: {
        runId:
          "insight-brief-1-aaaaaaaaaaaa-github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
        revision: currentRecord.retained.revision,
        generatedAt: "2026-08-01T00:00:00.000Z",
        provenance: {
          provider: "pi" as const,
          model: "model",
          reasoning: "medium" as const,
          language: "en" as const,
        },
        value: { goal: [{ text: "Guards recovery.", citations: ["h1"] }] },
      },
      updatedAt: "2026-08-01T00:01:00.000Z",
    };
    expect(parseInsightRecord(briefRecord)).toEqual({
      _tag: "ok",
      value: briefRecord,
    });
  });

  it("rejects duplicate Walkthrough progress IDs instead of normalizing them", () => {
    expect(
      parseInsightRecord({
        ...currentRecord,
        walkthroughProgress: {
          ...currentRecord.walkthroughProgress,
          reviewedSectionIds: ["section-1", "section-1"],
        },
      })._tag,
    ).toBe("err");
  });

  it("rejects a record that is both running and failed", () => {
    const { replacementFailure, ...withoutFailure } = currentRecord;
    const running = {
      ...withoutFailure,
      activeRun: {
        id: "insight-walkthrough-3-aaaaaaaaaaaa-github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
        type: "walkthrough" as const,
        revision: currentRecord.retained.revision,
        token: 3,
        provider: "pi" as const,
        model: "model",
        reasoning: "medium" as const,
        language: "en" as const,
        status: "running" as const,
        startedAt: "2026-08-01T00:02:00.000Z",
      },
    };

    expect(parseInsightRecord(running)._tag).toBe("ok");
    expect(parseInsightRecord({ ...running, replacementFailure })).toEqual({
      _tag: "err",
      error: expect.objectContaining({ reason: "invalid_stored_value" }),
    });
  });

  it("rejects historical unavailable provenance", () => {
    expect(
      parseInsightRecord({
        schemaVersion: 2,
        provenance: { provider: "pi", configuration: "un" + "available" },
      })._tag,
    ).toBe("err");
  });
});

it("rejects schema-2 records without current failure provenance", () => {
  expect(
    parseInsightRecord({
      schemaVersion: 2,
      reviewId: "github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
      type: "analysis",
      nextToken: 1,
      replacementFailure: {
        runId:
          "insight-analysis-1-aaaaaaaaaaaa-github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
        reason: "failed",
        retryable: true,
        failedAt: "2026-08-01T00:00:00.000Z",
      },
    })._tag,
  ).toBe("err");
});

describe("InsightStore Analysis Verification ticks", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });
  const profile = parseWorkspaceProfileId("acme");
  const review = parseReviewId(currentRecord.reviewId);
  const at = parseIsoTimestamp("2026-08-01T00:02:00.000Z");
  if (profile._tag === "err" || review._tag === "err" || at._tag === "err")
    throw new Error("invalid fixture ids");
  const { walkthroughProgress: _walkthroughOnly, ...walkthroughFree } =
    currentRecord;
  void _walkthroughOnly;
  const seed = { ...walkthroughFree, type: "analysis" as const };

  it("writes ticks atomically beside the retained Analysis and reads them back", async () => {
    root = await mkdtemp(join(tmpdir(), "patchdesk-insight-store-"));
    const paths = PatchdeskPaths.forTest(root);
    const store = new InsightStore(paths);
    const seeded = parseInsightRecord(seed);
    if (seeded._tag === "err") throw new Error("invalid seed record");
    await store.save(profile.value, seeded.value);

    const saved = await store.mutate({
      profileId: profile.value,
      reviewId: review.value,
      type: "analysis",
      now: at.value,
      operation: (record) =>
        setAnalysisVerificationStep(
          record,
          { index: 1, count: 2 },
          true,
          at.value,
        ),
    });

    expect(saved).toMatchObject({
      _tag: "ok",
      value: { analysisVerification: { checkedStepIndexes: [1] } },
    });
    const file = paths.insightFile(profile.value, review.value, "analysis");
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      analysisVerification: { checkedStepIndexes: [1] },
    });
    expect(await readdir(join(file, ".."))).toEqual(["analysis.json"]);
  });

  it("reads a record with duplicate ticked steps as invalid", async () => {
    root = await mkdtemp(join(tmpdir(), "patchdesk-insight-store-"));
    const paths = PatchdeskPaths.forTest(root);
    const store = new InsightStore(paths);
    const seeded = parseInsightRecord(seed);
    if (seeded._tag === "err") throw new Error("invalid seed record");
    await store.save(profile.value, seeded.value);
    const file = paths.insightFile(profile.value, review.value, "analysis");
    await writeFile(
      file,
      JSON.stringify({
        ...seed,
        analysisVerification: { checkedStepIndexes: [0, 0] },
      }),
      "utf8",
    );

    expect(
      await store.load(profile.value, review.value, "analysis"),
    ).toMatchObject({
      _tag: "err",
      error: { reason: "invalid_stored_value" },
    });
  });
});

describe("InsightStore mutate over a stored record it cannot use", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });
  const profile = parseWorkspaceProfileId("acme");
  const review = parseReviewId(currentRecord.reviewId);
  const at = parseIsoTimestamp("2026-08-01T00:02:00.000Z");
  if (profile._tag === "err" || review._tag === "err" || at._tag === "err")
    throw new Error("invalid fixture ids");
  const parsed = parseInsightRecord(currentRecord);
  if (parsed._tag === "err" || parsed.value.retained === undefined)
    throw new Error("invalid fixture record");
  const { runId, revision } = parsed.value.retained;
  const startRun = (store: InsightStore) =>
    store.mutate({
      profileId: profile.value,
      reviewId: review.value,
      type: "walkthrough",
      now: at.value,
      operation: (record) =>
        beginInsightRun(record, {
          id: runId,
          revision,
          provider: "pi",
          model: "model",
          reasoning: "medium",
          language: "en",
          startedAt: at.value,
        }),
    });

  it.each([
    ["unparseable JSON", "{"],
    ["a value that fails the schema", JSON.stringify({ schemaVersion: 1 })],
  ])("overwrites and heals a record holding %s", async (_label, contents) => {
    root = await mkdtemp(join(tmpdir(), "patchdesk-insight-store-"));
    const paths = PatchdeskPaths.forTest(root);
    const store = new InsightStore(paths);
    const file = paths.insightFile(profile.value, review.value, "walkthrough");
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, contents, "utf8");

    expect(await startRun(store)).toMatchObject({
      _tag: "ok",
      value: { activeRun: { id: runId, status: "queued" } },
    });
    expect(
      await store.load(profile.value, review.value, "walkthrough"),
    ).toMatchObject({
      _tag: "ok",
      value: { activeRun: { id: runId, status: "queued" } },
    });
  });

  it("fails closed without writing when the record cannot be read", async () => {
    root = await mkdtemp(join(tmpdir(), "patchdesk-insight-store-"));
    const paths = PatchdeskPaths.forTest(root);
    const store = new InsightStore(paths);
    const file = paths.insightFile(profile.value, review.value, "walkthrough");
    // A directory at the record path makes the read an I/O error rather than an absent file.
    await mkdir(file, { recursive: true });

    expect(await startRun(store)).toMatchObject({
      _tag: "err",
      error: { reason: "io" },
    });
    expect(await readdir(file)).toEqual([]);
  });
});

describe("InsightStore shadow preparation", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });
  const profile = parseWorkspaceProfileId("acme");
  const review = parseReviewId(currentRecord.reviewId);
  if (profile._tag === "err" || review._tag === "err")
    throw new Error("invalid shadow fixture ids");
  const shadowProfileId = profile.value;
  const shadowReviewId = review.value;

  it("refuses a FIFO source without waiting for its writer after cancellation", async () => {
    root = await mkdtemp(
      join(await realpath(tmpdir()), "patchdesk-shadow-repair-fifo-"),
    );
    const paths = PatchdeskPaths.forTest(root);
    const source = paths.insightFile(
      shadowProfileId,
      shadowReviewId,
      "analysis",
    );
    await mkdir(dirname(source), { recursive: true });
    execFileSync("mkfifo", [source]);
    const controller = new AbortController();
    let settled = false;
    let flags: string | number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await withShadowFileOpens(
      root,
      async (path, openedWith, openFile) => {
        if (path === source) {
          flags = openedWith;
          controller.abort();
        }
        return openFile();
      },
      async () => {
        const pending = new InsightMigrationService(paths)
          .prepareAnalysisShadow(profile.value, review.value, {
            signal: controller.signal,
          })
          .then((result) => {
            settled = true;
            return result;
          });
        try {
          return await Promise.race([
            pending,
            new Promise<"pending">((resolve) => {
              timeout = setTimeout(() => resolve("pending"), 1000);
            }),
          ]);
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
          if (!settled) {
            const writer = await open(
              source,
              constants.O_WRONLY | constants.O_NONBLOCK,
            );
            await writer.close();
          }
          await pending;
        }
      },
    );
    expect(outcome).toEqual({
      _tag: "err",
      error: { _tag: "AnalysisShadowFailure", reason: "storage_unavailable" },
    });
    expect(flags).toBe(
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    expect((await lstat(source)).isFIFO()).toBe(true);
    expect(await readdir(dirname(source))).toEqual(["analysis.json"]);
  });

  it("fails closed when syncing the parent of its first migration directory fails", async () => {
    root = await mkdtemp(
      join(await realpath(tmpdir()), "patchdesk-shadow-repair-sync-"),
    );
    const paths = PatchdeskPaths.forTest(root);
    const source = paths.insightFile(profile.value, review.value, "analysis");
    const original = Buffer.from('{"title":"original"}');
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, original);
    const faultDirectory = paths.dataDirectory();
    let parentSyncs = 0;
    let refuseSync = true;
    const outcomes = await withShadowFileOpens(
      root,
      async (path, _flags, openFile) => {
        const handle = await openFile();
        if (path === faultDirectory) {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            parentSyncs += 1;
            if (refuseSync) throw new Error("fixture parent sync failure");
            await sync();
          };
        }
        return handle;
      },
      async () => {
        const service = new InsightMigrationService(paths);
        const first = await service.prepareAnalysisShadow(
          profile.value,
          review.value,
        );
        const retry = await service.prepareAnalysisShadow(
          profile.value,
          review.value,
        );
        refuseSync = false;
        const recovered = await service.prepareAnalysisShadow(
          profile.value,
          review.value,
        );
        return { first, retry, recovered };
      },
    );
    expect(parentSyncs).toBe(3);
    expect(outcomes.first).toEqual({
      _tag: "err",
      error: { _tag: "AnalysisShadowFailure", reason: "storage_unavailable" },
    });
    expect(outcomes.retry).toEqual(outcomes.first);
    expect(outcomes.recovered._tag).toBe("ok");
    expect(await readFile(source)).toEqual(original);
  });

  it("spools ordered bounded lexical fragments from the same verified backup descriptor", async () => {
    root = await mkdtemp(
      join(await realpath(tmpdir()), "patchdesk-shadow-repair-lexical-"),
    );
    const paths = PatchdeskPaths.forTest(root);
    const source = paths.insightFile(profile.value, review.value, "analysis");
    const longText = "x".repeat(20000);
    const number = "1".repeat(5000);
    const original = Buffer.concat([
      Buffer.from('{"long":"' + longText + '\\uD800\\n","malformed":"'),
      Buffer.from([0xff]),
      Buffer.from('","dup":1,"dup":2,"number":' + number + "}"),
    ]);
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, original);
    const backupHandles: FileHandle[] = [];
    const reads: {
      readonly handle: FileHandle;
      readonly position: unknown;
    }[] = [];
    const outcome = await withShadowFileOpens(
      root,
      async (path, _flags, openFile) => {
        const handle = await openFile();
        if (path.endsWith("/source.json")) {
          backupHandles.push(handle);
          handle.read = new Proxy(handle.read.bind(handle), {
            apply(read, _receiver, args) {
              reads.push({ handle, position: args[3] });
              return read(args[0], args[1], args[2], args[3]);
            },
          });
        }
        return handle;
      },
      () =>
        new InsightMigrationService(paths).prepareAnalysisShadow(
          profile.value,
          review.value,
        ),
    );
    expect(outcome._tag).toBe("ok");
    if (outcome._tag === "err") throw new Error("shadow fixture failed");
    expect(await readFile(source)).toEqual(original);
    expect(
      await readFile(join(outcome.value.directory, "source.json")),
    ).toEqual(original);
    expect(outcome.value).toMatchObject({
      state: "structure_spooled",
      sourceBytes: original.length,
      sourceHash: createHash("sha256").update(original).digest("hex"),
      pending: "duplicates_sensitive_scan_schema_conversion_equality",
    });
    expect(backupHandles).toHaveLength(2);
    expect(reads.every((read) => read.handle === backupHandles[1])).toBe(true);
    expect(reads.filter((read) => read.position === 0)).toHaveLength(2);
    const raw: ReadonlyArray<LegacyJsonToken> = (
      await readFile(join(outcome.value.directory, "tokens.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line));
    const values: string[] = [];
    let value = "";
    for (const token of raw) {
      if (token.tag === "string_fragment" || token.tag === "number_fragment") {
        expect(token.value.length).toBeLessThanOrEqual(2048);
        value += token.value;
      }
      if (token.tag === "string_end" || token.tag === "number_end") {
        values.push(value);
        value = "";
      }
    }
    expect(values).toEqual([
      "long",
      longText + "\uD800\n",
      "malformed",
      "\uFFFD",
      "dup",
      "1",
      "dup",
      "2",
      "number",
      number,
    ]);
    expect(raw.filter((token) => token.tag === "punctuation")).toEqual([
      { tag: "punctuation", value: "{" },
      { tag: "punctuation", value: ":" },
      { tag: "punctuation", value: "," },
      { tag: "punctuation", value: ":" },
      { tag: "punctuation", value: "," },
      { tag: "punctuation", value: ":" },
      { tag: "punctuation", value: "," },
      { tag: "punctuation", value: ":" },
      { tag: "punctuation", value: "," },
      { tag: "punctuation", value: ":" },
      { tag: "punctuation", value: "}" },
    ]);
    expect(raw).toHaveLength(outcome.value.spool.tokens);
  });

  it("preserves every nested structural edge and duplicate-key occurrence on disk", async () => {
    const fixture = await structuralFixture(
      "[".repeat(512) + '{"dup":1,"dup":2,"empty":[]}' + "]".repeat(512),
    );
    const result = await new InsightMigrationService(
      fixture.paths,
    ).prepareAnalysisShadow(profile.value, review.value);
    expect(result._tag).toBe("ok");
    if (result._tag === "err") throw new Error("structural fixture failed");
    expect(result.value.state).toBe("structure_spooled");
    expect(result.value.structure).toEqual({
      root: 1,
      values: 516,
      keys: 3,
      records: 1559,
      maxDepth: 514,
    });
    expect(await readFile(fixture.source)).toEqual(fixture.original);
    expect(await readFile(join(result.value.directory, "source.json"))).toEqual(
      fixture.original,
    );
    expect((await stat(join(result.value.directory, "frames.bin"))).size).toBe(
      514 * 512,
    );
    const rows: ReadonlyArray<{ readonly tag: string }> = (
      await readFile(join(result.value.directory, "structure.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line));
    const children = rows.filter((row) => row.tag === "child");
    expect(children).toHaveLength(515);
    for (let parent = 1; parent <= 512; parent += 1)
      expect(children[parent - 1]).toEqual({
        tag: "child",
        parent,
        id: parent + 1,
        ordinal: 0,
        key: null,
      });
    expect(children.slice(512)).toEqual([
      { tag: "child", parent: 513, id: 515, ordinal: 0, key: 514 },
      { tag: "child", parent: 513, id: 517, ordinal: 1, key: 516 },
      { tag: "child", parent: 513, id: 519, ordinal: 2, key: 518 },
    ]);
    expect(rows.filter((row) => row.tag === "fragment")).toEqual([
      { tag: "fragment", id: 514, sequence: 0, text: "dup" },
      { tag: "fragment", id: 515, sequence: 0, text: "1" },
      { tag: "fragment", id: 516, sequence: 0, text: "dup" },
      { tag: "fragment", id: 517, sequence: 0, text: "2" },
      { tag: "fragment", id: 518, sequence: 0, text: "empty" },
    ]);
    expect(rows).toHaveLength(result.value.structure.records);
  });

  it("refuses a lexically valid trailing comma and preserves the original backup", async () => {
    const fixture = await structuralFixture("[1,]");
    const result = await new InsightMigrationService(
      fixture.paths,
    ).prepareAnalysisShadow(profile.value, review.value);
    expect(result).toEqual({
      _tag: "err",
      error: { _tag: "AnalysisShadowFailure", reason: "invalid_legacy" },
    });
    expect(await readFile(fixture.source)).toEqual(fixture.original);
    expect(await failedStructuralBackup(fixture.paths)).toEqual(
      fixture.original,
    );
  });

  it("refuses a second root value and preserves the original backup", async () => {
    const fixture = await structuralFixture("0 1");
    const result = await new InsightMigrationService(
      fixture.paths,
    ).prepareAnalysisShadow(profile.value, review.value);
    expect(result).toEqual({
      _tag: "err",
      error: { _tag: "AnalysisShadowFailure", reason: "invalid_legacy" },
    });
    expect(await readFile(fixture.source)).toEqual(fixture.original);
    expect(await failedStructuralBackup(fixture.paths)).toEqual(
      fixture.original,
    );
  });

  async function structuralFixture(text: string) {
    root = await mkdtemp(
      join(await realpath(tmpdir()), "patchdesk-shadow-structure-"),
    );
    const paths = PatchdeskPaths.forTest(root);
    const source = paths.insightFile(
      shadowProfileId,
      shadowReviewId,
      "analysis",
    );
    const original = Buffer.from(text);
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, original);
    return { paths, source, original };
  }

  async function failedStructuralBackup(paths: PatchdeskPaths) {
    const directory = paths.insightMigrationDirectory(
      shadowProfileId,
      shadowReviewId,
    );
    const attempts = await readdir(directory);
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0];
    if (attempt === undefined)
      throw new Error("structural fixture backup missing");
    return readFile(join(directory, attempt, "source.json"));
  }
});

async function withShadowFileOpens<T>(
  root: string,
  observe: (
    path: string,
    flags: string | number | undefined,
    openFile: () => Promise<FileHandle>,
  ) => Promise<FileHandle>,
  run: () => Promise<T>,
): Promise<T> {
  const originalOpen = filesystem.open;
  filesystem.open = async (path, flags, mode) => {
    const openFile = () => originalOpen(path, flags, mode);
    if (path instanceof URL || Buffer.isBuffer(path)) return openFile();
    return isPathContained(root, path)
      ? observe(path, flags, openFile)
      : openFile();
  };
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    filesystem.open = originalOpen;
    syncBuiltinESMExports();
  }
}
