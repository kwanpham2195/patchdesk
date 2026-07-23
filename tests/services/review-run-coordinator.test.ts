import { describe, expect, it, vi } from "vitest";

import { ok } from "../../src/domain/result";
import { ReviewRunCoordinator } from "../../src/services/review-run-coordinator";

const input = {
  profileId: "cfw",
  sessionId: "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__abcdef123456",
  attemptId: "001",
  metadata: {
    agent: "Patchdesk review agent" as const,
    model: "opencode-go/deepseek-v4-flash",
    reasoning: "medium" as const,
    mode: "Full review" as const,
    access: "Read-only repository inspection" as const,
  },
};

describe("review run coordinator", () => {
  it("starts one background execution and returns the owned run for duplicate starts", async () => {
    let finish: (() => void) | undefined;
    const workflow = {
      start: vi.fn(
        () =>
          new Promise<ReturnType<typeof ok<{ readonly runId: string }>>>((resolve) => {
            finish = () => resolve(ok({ runId: "private-flue-run" }));
          }),
      ),
    };
    const coordinator = new ReviewRunCoordinator(workflow);

    const first = coordinator.start(input);
    const duplicate = coordinator.start(input);

    expect(duplicate).toBe(first);
    expect(first).not.toHaveProperty("profileId");
    expect(workflow.start).toHaveBeenCalledTimes(1);
    expect(coordinator.observe({ ...input, runId: first.runId })).toMatchObject({
      _tag: "ok",
      value: { status: "running", step: "inspecting", metadata: input.metadata },
    });

    finish?.();
    await vi.waitFor(() => {
      expect(coordinator.observe({ ...input, runId: first.runId })).toMatchObject({
        _tag: "ok",
        value: { status: "completed", step: "complete" },
      });
    });
    expect(JSON.stringify(coordinator.observe({ ...input, runId: first.runId }))).not.toContain(
      "private-flue-run",
    );
  });

  it("does not restart a terminal run for the same session and attempt", async () => {
    const workflow = {
      start: vi.fn(async () => ok({ runId: "private-flue-run" })),
    };
    const coordinator = new ReviewRunCoordinator(workflow);
    const run = coordinator.start(input);
    await vi.waitFor(() => {
      expect(coordinator.observe({ ...input, runId: run.runId })).toMatchObject({
        value: { status: "completed" },
      });
    });

    expect(coordinator.start(input).runId).toBe(run.runId);
    expect(workflow.start).toHaveBeenCalledTimes(1);
  });

  it("reports only owned workflow milestones without forwarding provider output", async () => {
    const coordinator = new ReviewRunCoordinator({
      start: async (_input, options) => {
        options?.onActivity?.("validating");
        options?.onActivity?.("drafting");
        return ok({});
      },
    });
    const run = coordinator.start(input);

    await vi.waitFor(() => {
      expect(coordinator.observe({ ...input, runId: run.runId })).toMatchObject({
        value: {
          status: "completed",
          activity: [
            { step: "preparing", label: "Preparing review snapshot" },
            { step: "inspecting", label: "Inspecting changed files" },
            { step: "validating", label: "Validating findings" },
            { step: "drafting", label: "Drafting review result" },
            { step: "complete", label: "Review result is ready" },
          ],
        },
      });
    });
  });

  it("rejects observation by another owner", () => {
    const coordinator = new ReviewRunCoordinator({
      start: async () => new Promise(() => undefined),
    });
    const run = coordinator.start(input);

    expect(
      coordinator.observe({
        runId: run.runId,
        sessionId: input.sessionId,
        attemptId: "002",
      }),
    ).toEqual({ _tag: "err", error: { _tag: "RunNotOwned" } });
  });

  it("turns workflow failures and thrown details into a coarse safe projection", async () => {
    let now = 10;
    const coordinator = new ReviewRunCoordinator(
      {
        start: async () => {
          throw new Error("credential=secret raw Flue stderr");
        },
      },
      undefined,
      () => now,
    );
    const run = coordinator.start(input);
    now = 35;

    await vi.waitFor(() => {
      expect(coordinator.observe({ ...input, runId: run.runId })).toMatchObject({
        _tag: "ok",
        value: {
          status: "failed",
          elapsedMs: 25,
          step: "failed",
          message: "Review run failed",
          activity: [
            { step: "preparing", label: "Preparing review snapshot" },
            { step: "inspecting", label: "Inspecting changed files" },
            { step: "failed", label: "Review stopped" },
          ],
        },
      });
    });
  });
});
