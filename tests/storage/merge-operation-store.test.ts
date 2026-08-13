import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MergeOperationStore } from "../../src/adapters/storage/merge-operation-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

describe("MergeOperationStore", () => {
  it("round-trips Review-bound operation evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-merge-"));
    roots.push(root);
    const sessionId =
      "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__0123456789ab" as never;
    const reviewId =
      "github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa" as never;
    const operation = {
      operationId: "merge-1",
      profileId: "cfw",
      reviewId,
      sessionId,
      pr: {
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number: 42,
      },
      expectedHeadSha: "abcdef1234567890abcdef1234567890abcdef12",
      method: "squash",
      acknowledgedWarningCodes: [],
      startedAt: "2026-08-01T00:00:00.000Z",
      state: { _tag: "Requested" },
    } as never;
    const store = new MergeOperationStore(PatchdeskPaths.forTest(root));
    await expect(store.begin(operation)).resolves.toMatchObject({ _tag: "ok" });
    await expect(store.load("cfw" as never, sessionId)).resolves.toMatchObject({
      _tag: "ok",
      value: { reviewId },
    });
  });

  it("does not overwrite unresolved merge evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-merge-"));
    roots.push(root);
    const sessionId =
      "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__0123456789ab" as never;
    const reviewId =
      "github.com__centraldigital__patchdesk__pr-42__review-aaaaaaaaaaaa" as never;
    const operation = {
      operationId: "merge-1",
      profileId: "cfw",
      reviewId,
      sessionId,
      pr: {
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number: 42,
      },
      expectedHeadSha: "abcdef1234567890abcdef1234567890abcdef12",
      method: "squash",
      acknowledgedWarningCodes: [],
      startedAt: "2026-08-01T00:00:00.000Z",
      state: { _tag: "OutcomeUnknown" },
    } as never;
    const store = new MergeOperationStore(PatchdeskPaths.forTest(root));
    await expect(store.markOutcomeUnknown(operation)).resolves.toMatchObject({
      _tag: "ok",
    });
    const retry = {
      operationId: "merge-2",
      profileId: "cfw",
      reviewId,
      sessionId,
      pr: {
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number: 42,
      },
      expectedHeadSha: "abcdef1234567890abcdef1234567890abcdef12",
      method: "squash",
      acknowledgedWarningCodes: [],
      startedAt: "2026-08-01T00:01:00.000Z",
      state: { _tag: "Requested" },
    } as never;
    await expect(store.begin(retry)).resolves.toEqual({
      _tag: "err",
      error: { _tag: "MergeOperationExists" },
    });
    await expect(store.load("cfw" as never, sessionId)).resolves.toMatchObject({
      _tag: "ok",
      value: { operationId: "merge-1", state: { _tag: "OutcomeUnknown" } },
    });
  });
});
