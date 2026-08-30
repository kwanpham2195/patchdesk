import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import { ReviewWriteOperationStore } from "../../src/adapters/storage/review-write-operation-store";
import { parseReviewWriteOperation } from "../../src/domain/review-write-operation";

let root: string | undefined;
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

function operation() {
  const parsed = parseReviewWriteOperation({
    schemaVersion: 1,
    profileId: "cfw",
    reviewId: "cfw__centraldigital__patchdesk__pr-42__review-abcdef123456",
    sessionId:
      "github.com__centraldigital__patchdesk__pr-42__sha-11111111__base-22222222__abcdef123456",
    intent: {
      _tag: "DeleteComment",
      expected: {
        sessionId:
          "github.com__centraldigital__patchdesk__pr-42__sha-11111111__base-22222222__abcdef123456",
        headSha: "1".repeat(40),
        patchHash: "a".repeat(64),
      },
      commentId: "PRRC_comment",
    },
    state: { _tag: "Requested" },
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  if (parsed._tag === "err") throw new Error("invalid fixture");
  return parsed.value;
}

describe("ReviewWriteOperationStore", () => {
  it("atomically begins, loads, and refuses to overwrite an active operation", async () => {
    root = await mkdtemp(join(tmpdir(), "patchdesk-write-operation-"));
    const store = new ReviewWriteOperationStore(PatchdeskPaths.forTest(root));
    const value = operation();
    await expect(store.begin(value)).resolves.toEqual({
      _tag: "ok",
      value: undefined,
    });
    await expect(store.load(value.profileId, value.reviewId)).resolves.toEqual({
      _tag: "ok",
      value,
    });
    await expect(store.begin(value)).resolves.toEqual({
      _tag: "err",
      error: { _tag: "ReviewWriteOperationExists" },
    });
  });

  it("admits only one of two concurrent begin attempts", async () => {
    root = await mkdtemp(join(tmpdir(), "patchdesk-write-operation-"));
    const store = new ReviewWriteOperationStore(PatchdeskPaths.forTest(root));
    const value = operation();
    const results = await Promise.all([store.begin(value), store.begin(value)]);
    expect(results).toContainEqual({ _tag: "ok", value: undefined });
    expect(results).toContainEqual({
      _tag: "err",
      error: { _tag: "ReviewWriteOperationExists" },
    });
  });

  it("fails closed for malformed stored data and removes only explicitly", async () => {
    root = await mkdtemp(join(tmpdir(), "patchdesk-write-operation-"));
    const paths = PatchdeskPaths.forTest(root);
    const store = new ReviewWriteOperationStore(paths);
    const value = operation();
    await store.begin(value);
    await writeFile(
      paths.reviewWriteOperationFile(value.profileId, value.reviewId),
      JSON.stringify({ schemaVersion: 99 }),
    );
    await expect(store.load(value.profileId, value.reviewId)).resolves.toEqual({
      _tag: "err",
      error: {
        _tag: "StorageFailure",
        operation: "read",
        reason: "invalid_stored_value",
      },
    });
    expect(
      await readFile(
        paths.reviewWriteOperationFile(value.profileId, value.reviewId),
        "utf8",
      ),
    ).toContain("schemaVersion");
    await expect(
      store.remove(value.profileId, value.reviewId),
    ).resolves.toEqual({
      _tag: "ok",
      value: undefined,
    });
    await expect(store.load(value.profileId, value.reviewId)).resolves.toEqual({
      _tag: "ok",
      value: undefined,
    });
  });
});
