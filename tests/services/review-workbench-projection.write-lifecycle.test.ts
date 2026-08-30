import { describe, expect, it } from "vitest";

import { parseReviewWriteOperation } from "../../src/domain/review-write-operation";
import { err, ok } from "../../src/domain/result";
import {
  at,
  fixture,
  hash,
  headSha,
  profileId,
  reviewId,
  sessionId,
  snapshot,
} from "./review-workbench-projection-fixture";

describe("ReviewWorkbenchProjectionService durable write lifecycle", () => {
  function activeWrite(
    state:
      | { readonly _tag: "Requested" | "Confirmed" }
      | {
          readonly _tag: "OutcomeUnknown";
          readonly resolution: "check_required" | "manual_resolution_required";
        },
  ) {
    const parsed = parseReviewWriteOperation({
      schemaVersion: 1,
      profileId,
      reviewId,
      sessionId,
      intent: {
        _tag: "Reply",
        expected: { sessionId, headSha, patchHash: hash },
        actor: "fixture",
        threadId: "PRRT_thread",
        body: "reply",
      },
      state,
      startedAt: at,
    });
    if (parsed._tag === "err") throw new Error("invalid fixture operation");
    return parsed.value;
  }

  it("fails closed when an injected profile bypasses its bounded GitHub login parser", async () => {
    const value = fixture();
    value.profiles.load.mockResolvedValueOnce(
      // SAFETY: this fixture deliberately bypasses persisted-profile parsing to prove projection fails closed.
      ok({ ghAccount: "a".repeat(40) }) as never,
    );
    await expect(
      value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot,
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      }),
    ).resolves.toEqual({
      _tag: "err",
      error: { _tag: "SessionStorageUnavailable" },
    });
  });

  it("projects only bounded recovery data for durable requested and confirmed operations", async () => {
    for (const state of [
      { _tag: "Requested" },
      { _tag: "Confirmed" },
    ] as const) {
      const value = fixture();
      value.writeOperations.load.mockResolvedValueOnce(
        // SAFETY: this mock value matches the operation store's successful load result.
        ok(activeWrite(state)) as never,
      );
      const result = await value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot,
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      });
      expect(result).toMatchObject({
        _tag: "ok",
        value: {
          remoteWriteRecovery: {
            operation: "Reply",
            resolution: "check_required",
          },
        },
      });
      if (result._tag === "ok")
        expect(result.value.remoteWriteRecovery).toEqual({
          operation: "Reply",
          resolution: "check_required",
        });
    }
  });

  it("fails closed when durable write-operation storage is malformed", async () => {
    const value = fixture();
    value.writeOperations.load.mockResolvedValueOnce(
      // SAFETY: this mock value matches the operation store's storage-failure result.
      err({
        _tag: "StorageFailure",
        operation: "read",
        reason: "invalid_stored_value",
      }) as never,
    );
    await expect(
      value.service.loadRepresented({
        profileId,
        sessionId,
        snapshot,
        refreshedAt: at,
        freshness: { _tag: "Fresh" },
      }),
    ).resolves.toEqual({
      _tag: "err",
      error: { _tag: "SessionStorageUnavailable" },
    });
  });

  it("preserves manual-resolution-required from durable operation state", async () => {
    const value = fixture();
    value.writeOperations.load.mockResolvedValueOnce(
      // SAFETY: this mock value matches the operation store's successful load result.
      ok(
        activeWrite({
          _tag: "OutcomeUnknown",
          resolution: "manual_resolution_required",
        }),
      ) as never,
    );
    const result = await value.service.loadRepresented({
      profileId,
      sessionId,
      snapshot,
      refreshedAt: at,
      freshness: { _tag: "Fresh" },
    });
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        remoteWriteRecovery: {
          operation: "Reply",
          resolution: "manual_resolution_required",
        },
      },
    });
  });
});
