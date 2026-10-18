import { readBoundedInsightArtifactFile } from "#src/adapters/storage/insight-artifact-files";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  InsightStore,
  parseInsightRecord,
} from "#src/adapters/storage/insight-store";
import { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import {
  buildGuideInventory,
  parseRetainedGuide,
  retainGuide,
} from "#src/domain/guide";
import { initialGuideReadingState } from "#src/domain/guide-reading-state";
import { parseWorkspaceProfileId, parseInsightRunId } from "#src/domain/ids";
import {
  beginInsightRun,
  completeInsightRun,
} from "#src/domain/insight-record";
import { err, ok, type Result } from "#src/domain/result";
import type { StorageFailure } from "#src/adapters/storage/json-file";
import { saveGuideReadingState } from "#src/services/guide-reading-state-service";

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("Invalid Guide fixture");
  return result.value;
}
const patch =
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const guide = must(
  retainGuide(
    {
      groups: [
        {
          title: "Recover",
          explanation: "Resumes the request.",
          files: [{ fileId: "f1", relevance: "Owns recovery." }],
        },
      ],
    },
    { patchText: patch, inventory: must(buildGuideInventory(patch)) },
  ),
);
const profileId = must(parseWorkspaceProfileId("acme"));
const seed = must(
  parseInsightRecord({
    schemaVersion: 2,
    reviewId: "github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
    type: "guide",
    nextToken: 2,
    retained: {
      runId:
        "insight-guide-1-aaaaaaaaaaaa-github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
      revision: {
        sessionId:
          "github.com__octo-org__patchdesk__pr-42__sha-aaaaaaaa__base-00000000__b48f8e2e76ca",
        headSha: "a".repeat(40),
        patchHash: createHash("sha256").update(patch).digest("hex"),
      },
      generatedAt: "2026-08-01T00:00:00.000Z",
      provenance: {
        provider: "pi",
        model: "model",
        reasoning: "medium",
        language: "en",
      },
      value: guide,
    },
    updatedAt: "2026-08-01T00:01:00.000Z",
  }),
);
if (seed.retained === undefined) throw new Error("Missing retained fixture");
const retained = { ...seed.retained, value: guide };
const input = {
  profileId,
  reviewId: seed.reviewId,
  runId: retained.runId,
  sessionId: retained.revision.sessionId,
  expectedStateVersion: 0,
  state: {
    reviewedGroupIds: ["g1"],
    expandedAppearances: [{ groupId: "g1", fileId: "f1" }],
    anchor: { kind: "file" as const, groupId: "g1", fileId: "f1", offset: 38 },
  },
};
let root: string | undefined;
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});
class ControlledInsightStore extends InsightStore {
  beforeSave: (() => Promise<Result<void, StorageFailure>>) | undefined;

  override async save(
    profile: Parameters<InsightStore["save"]>[0],
    record: Parameters<InsightStore["save"]>[1],
  ): ReturnType<InsightStore["save"]> {
    const intercept = this.beforeSave;
    this.beforeSave = undefined;
    if (intercept !== undefined) {
      const result = await intercept();
      if (result._tag === "err") return result;
    }
    return super.save(profile, record);
  }
}

async function setup() {
  root = await mkdtemp(join(tmpdir(), "patchdesk-guide-reading-"));
  const paths = PatchdeskPaths.forTest(root);
  const store = new ControlledInsightStore(
    paths,
    readBoundedInsightArtifactFile,
  );
  must(await store.save(profileId, seed));
  return { paths, store };
}

describe("Guide reading-state authority", () => {
  it("refuses a retained patch hash mismatch without changing stored bytes", async () => {
    const { paths, store } = await setup();
    const file = paths.insightFile(profileId, seed.reviewId, "guide");
    const corrupted = JSON.stringify({
      ...seed,
      retained: {
        ...retained,
        revision: { ...retained.revision, patchHash: "b".repeat(64) },
      },
    });
    await writeFile(file, corrupted);
    expect(
      await store.loadTyped(
        profileId,
        seed.reviewId,
        "guide",
        parseRetainedGuide,
      ),
    ).toMatchObject({ _tag: "err" });
    expect(
      await saveGuideReadingState(store, input, seed.updatedAt, async () =>
        ok(undefined),
      ),
    ).toEqual({ _tag: "err", error: "invalid_reading_state" });
    expect(await readFile(file, "utf8")).toBe(corrupted);
  });
  it("defines version zero only for absent progress", () => {
    expect(initialGuideReadingState(retained)).toMatchObject({
      version: 0,
      anchor: { kind: "top" },
      reviewedGroupIds: [],
      expandedAppearances: [],
    });
    expect(parseInsightRecord({ ...seed, guideReadingState: null })._tag).toBe(
      "err",
    );
  });
  it.each([
    ["unknown group", { ...input.state, reviewedGroupIds: ["g99"] }],
    ["duplicate marks", { ...input.state, reviewedGroupIds: ["g1", "g1"] }],
    [
      "nonmember appearance",
      {
        ...input.state,
        expandedAppearances: [{ groupId: "others", fileId: "f1" }],
      },
    ],
    [
      "duplicate appearance",
      {
        ...input.state,
        expandedAppearances: [
          input.state.expandedAppearances[0],
          input.state.expandedAppearances[0],
        ],
      },
    ],
    [
      "unknown anchor",
      {
        ...input.state,
        anchor: { kind: "file", groupId: "g1", fileId: "f99", offset: 0 },
      },
    ],
    [
      "nonfinite offset",
      {
        ...input.state,
        anchor: { kind: "group", groupId: "g1", offset: Infinity },
      },
    ],
  ])("rejects explicit %s instead of resetting it", (_name, state) => {
    expect(
      parseInsightRecord({
        ...seed,
        guideReadingState: { ...initialGuideReadingState(retained), ...state },
      })._tag,
    ).toBe("err");
  });
  it("persists progress beside the represented snapshot and reloads it after reconstruction", async () => {
    const { paths, store } = await setup();
    const saved = must(
      await saveGuideReadingState(store, input, seed.updatedAt, async () =>
        ok(undefined),
      ),
    );
    expect(saved.version).toBe(1);
    const reloaded = must(
      await new InsightStore(paths, readBoundedInsightArtifactFile).loadTyped(
        profileId,
        seed.reviewId,
        "guide",
        parseRetainedGuide,
      ),
    );
    expect(reloaded.guideReadingState?.anchor).toEqual(input.state.anchor);
    expect(reloaded.guideReadingState?.expandedAppearances).toEqual(
      input.state.expandedAppearances,
    );
    expect(reloaded.retained?.value.patchText).toBe(patch);
  });
  it("refuses a stale version without changing confirmed progress", async () => {
    const { store } = await setup();
    must(
      await saveGuideReadingState(store, input, seed.updatedAt, async () =>
        ok(undefined),
      ),
    );
    expect(
      await saveGuideReadingState(
        store,
        { ...input, state: { ...input.state, reviewedGroupIds: [] } },
        seed.updatedAt,
        async () => ok(undefined),
      ),
    ).toEqual({ _tag: "err", error: "guide_version_conflict" });
    expect(
      must(await store.load(profileId, seed.reviewId, "guide"))
        .guideReadingState?.reviewedGroupIds,
    ).toEqual(["g1"]);
  });
  it("preserves malformed stored authority when a reading-state save is requested", async () => {
    const { paths, store } = await setup();
    const file = paths.insightFile(profileId, seed.reviewId, "guide");
    const malformed = JSON.stringify({
      ...seed,
      guideReadingState: { version: -1 },
    });
    await writeFile(file, malformed);
    expect(
      await saveGuideReadingState(store, input, seed.updatedAt, async () =>
        ok(undefined),
      ),
    ).toEqual({ _tag: "err", error: "storage_unavailable" });
    expect(await readFile(file, "utf8")).toBe(malformed);
  });
  it("resets progress atomically when replacement races with a save", async () => {
    const { store } = await setup();
    const replacementId = must(
      parseInsightRunId(
        "insight-guide-2-aaaaaaaaaaaa-github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
      ),
    );
    const begun = must(
      await store.mutate({
        profileId,
        reviewId: seed.reviewId,
        type: "guide",
        now: seed.updatedAt,
        operation: (record) =>
          beginInsightRun(record, {
            id: replacementId,
            revision: retained.revision,
            provider: "pi",
            model: "model",
            reasoning: "medium",
            language: "en",
            startedAt: seed.updatedAt,
          }),
      }),
    );
    expect(begun.activeRun?.status).toBe("queued");
    let resumeWrite: (() => void) | undefined;
    let enteredWrite: (() => void) | undefined;
    const writeEntered = new Promise<void>((resolve) => {
      enteredWrite = resolve;
    });
    const writeAllowed = new Promise<void>((resolve) => {
      resumeWrite = resolve;
    });
    store.beforeSave = async () => {
      enteredWrite?.();
      await writeAllowed;
      return ok(undefined);
    };
    const save = saveGuideReadingState(store, input, seed.updatedAt, async () =>
      ok(undefined),
    );
    await writeEntered;
    const replace = store.mutate({
      profileId,
      reviewId: seed.reviewId,
      type: "guide",
      now: seed.updatedAt,
      operation: (record) =>
        completeInsightRun(
          record,
          replacementId,
          { ...retained, runId: replacementId },
          seed.updatedAt,
        ),
    });
    resumeWrite?.();
    const results = await Promise.all([save, replace]);
    expect(results[0]).toMatchObject({ _tag: "ok", value: { version: 1 } });
    expect(results[1]?._tag).toBe("ok");
    const loaded = must(
      await store.loadTyped(
        profileId,
        seed.reviewId,
        "guide",
        parseRetainedGuide,
      ),
    );
    expect(loaded.guideReadingState).toBeUndefined();
    expect(loaded.retained?.value.patchText).toBe(patch);
    expect(loaded.retained?.runId).toBe(replacementId);
    expect(
      await saveGuideReadingState(store, input, seed.updatedAt, async () =>
        ok(undefined),
      ),
    ).toEqual({ _tag: "err", error: "guide_identity_conflict" });
  });

  it("leaves confirmed progress and snapshot intact after a write fault, then retries the same version", async () => {
    const { store } = await setup();
    must(
      await saveGuideReadingState(store, input, seed.updatedAt, async () =>
        ok(undefined),
      ),
    );
    const next = {
      ...input,
      expectedStateVersion: 1,
      state: { ...input.state, reviewedGroupIds: [] },
    };
    store.beforeSave = async () =>
      err({ _tag: "StorageFailure", operation: "write", reason: "io" });
    expect(
      await saveGuideReadingState(store, next, seed.updatedAt, async () =>
        ok(undefined),
      ),
    ).toEqual({ _tag: "err", error: "storage_unavailable" });
    const loaded = must(
      await store.loadTyped(
        profileId,
        seed.reviewId,
        "guide",
        parseRetainedGuide,
      ),
    );
    expect(loaded.guideReadingState?.version).toBe(1);
    expect(loaded.guideReadingState?.reviewedGroupIds).toEqual(["g1"]);
    expect(loaded.retained?.value.patchText).toBe(patch);
    expect(
      must(
        await saveGuideReadingState(store, next, seed.updatedAt, async () =>
          ok(undefined),
        ),
      ),
    ).toMatchObject({ version: 2, reviewedGroupIds: [] });
  });
});
