import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ReviewId, WorkspaceProfileId } from "../../src/domain/ids";
import { ok, err, type Result } from "../../src/domain/result";
import type { RecentReviewWrite } from "../../src/domain/recent-review-write";
import { registerReviewWriteRoutes } from "../../src/main/routes/review-write-routes";
import type {
  ReviewWriteRecovery,
  ReviewWriteRecoveryFailure,
} from "../../src/services/review-write-recovery-service";

const body = {
  profileId: "cfw",
  reviewId: "cfw__centraldigital__patchdesk__pr-42__review-abcdef123456",
};

function routeFixture(
  recovered: Result<ReviewWriteRecovery, ReviewWriteRecoveryFailure>,
  projection: {
    readonly state: string;
    readonly remoteWriteRecovery?: {
      readonly operation: string;
      readonly resolution: string;
    };
  },
  detection: Result<unknown, { readonly reason: string }> = ok(undefined),
) {
  const app = new Hono();
  type RecoveryInput = {
    readonly profileId: WorkspaceProfileId;
    readonly reviewId: ReviewId;
  };
  type DetectionInput = RecoveryInput & {
    readonly recentWrites?: ReadonlyArray<RecentReviewWrite>;
  };
  const recoveryInputs: Array<RecoveryInput> = [];
  const detectionInputs: Array<DetectionInput> = [];
  let mutationCalls = 0;
  const unusedWriteService = {
    execute: async () => {
      mutationCalls += 1;
      return err("invalid_input");
    },
    list: async () => err("invalid_input"),
  };
  const container = {
    logs: { write: () => undefined },
    inlineConversations: unusedWriteService,
    labelWrites: unusedWriteService,
    assigneeWrites: unusedWriteService,
    reviewerWrites: unusedWriteService,
    reviewWriteRecovery: {
      recover: async (input: RecoveryInput) => {
        recoveryInputs.push(input);
        return recovered;
      },
    },
    reviewWorkbench: {
      detectUpdates: async (input: DetectionInput) => {
        detectionInputs.push(input);
        return detection;
      },
      load: async () => ok(projection),
    },
  };
  // SAFETY: the route under test reaches only the explicitly supplied service seams.
  registerReviewWriteRoutes(app, container as never);
  return {
    request: (
      requestBody: {
        readonly profileId: string;
        readonly reviewId: string;
        readonly replay?: boolean;
      } = body,
    ) =>
      app.request("/v1/reviews/write/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      }),
    recoveryInputs,
    detectionInputs,
    mutationCalls: () => mutationCalls,
  };
}

describe("POST /v1/reviews/write/recover", () => {
  it("returns a retained durable lock without observing or replaying a mutation", async () => {
    const projection = {
      state: "review",
      remoteWriteRecovery: {
        operation: "Reply",
        resolution: "check_required",
      },
    };
    const fixture = routeFixture(ok({ _tag: "CheckRequired" }), projection);
    const response = await fixture.request();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(projection);
    expect(fixture.recoveryInputs).toHaveLength(1);
    expect(fixture.detectionInputs).toEqual([]);
    expect(fixture.mutationCalls()).toBe(0);
  });

  it("observes a confirmed receipt once before returning the cleared projection", async () => {
    const receipt: RecentReviewWrite = {
      _tag: "Comment",
      commentId: "PRRC_reply",
    };
    const projection = { state: "review" };
    const fixture = routeFixture(
      ok({ _tag: "Confirmed", receipt }),
      projection,
    );
    const response = await fixture.request();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(projection);
    expect(fixture.detectionInputs).toEqual([
      { ...body, recentWrites: [receipt] },
    ]);
    expect(fixture.mutationCalls()).toBe(0);
  });

  it("observes confirmed deletion without fabricating a recent-write receipt", async () => {
    const fixture = routeFixture(ok({ _tag: "Confirmed" }), {
      state: "review",
    });
    const response = await fixture.request();
    expect(response.status).toBe(200);
    expect(fixture.detectionInputs).toEqual([body]);
    expect(fixture.mutationCalls()).toBe(0);
  });

  it("reads before clearing an ephemeral NoOperation lock and retains it when detection fails", async () => {
    const fixture = routeFixture(
      ok({ _tag: "NoOperation" }),
      { state: "review" },
      err({ reason: "storage" }),
    );
    const response = await fixture.request();
    expect(response.status).toBe(503);
    expect(fixture.detectionInputs).toEqual([body]);
  });

  it("strictly rejects malformed recovery input before calling the service", async () => {
    const fixture = routeFixture(ok({ _tag: "NoOperation" }), {
      state: "review",
    });
    const response = await fixture.request({ ...body, replay: true });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_input" });
    expect(fixture.recoveryInputs).toEqual([]);
  });
  it("maps bounded recovery failures without returning raw causes", async () => {
    for (const [failure, status] of [
      ["not_found", 404],
      ["not_fresh", 409],
      ["review_write_in_progress", 409],
      ["github_read_failed", 503],
      ["storage", 503],
    ] as const) {
      const fixture = routeFixture(err(failure), { state: "review" });
      const response = await fixture.request();
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error: failure });
    }
  });
});
