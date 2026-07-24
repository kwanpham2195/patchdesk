import { describe, expect, it } from "vitest";

import { projectSafeRun } from "../../src/services/run-projection";

describe("safe Flue run projection", () => {
  it("projects unknown provider fields away from the renderer contract", () => {
    expect(projectSafeRun({
      status: "running",
      elapsedMs: 4,
      step: "inspecting",
      message: "Reading changed files",
      prompt: "secret",
    })).toEqual({
      _tag: "ok",
      value: {
        status: "running",
        elapsedMs: 4,
        step: "inspecting",
        message: "Reading changed files",
      },
    });
    expect(projectSafeRun({ status: "disconnected", elapsedMs: 4, step: "inspecting" })).toMatchObject({ _tag: "ok" });
  });

  it("accepts only safe optional evidence references", () => {
    expect(projectSafeRun({
      status: "running",
      elapsedMs: 0,
      step: "inspecting",
      activity: [{
        at: "2026-07-24T00:00:00.000Z",
        elapsedMs: 0,
        step: "inspecting",
        label: "Inspecting src/review.ts",
        path: "src/review.ts",
        findingId: "finding-1",
      }],
    })).toMatchObject({ _tag: "ok", value: { activity: [{ path: "src/review.ts", findingId: "finding-1" }] } });

    expect(projectSafeRun({
      status: "running",
      elapsedMs: 0,
      step: "inspecting",
      activity: [{
        at: "2026-07-24T00:00:00.000Z",
        elapsedMs: 0,
        step: "inspecting",
        label: "Invalid path",
        path: "/private/file",
      }],
    })).toEqual({ _tag: "err", error: { _tag: "InvalidRunProjection" } });
  });

  it("rejects malformed bounded metadata and activity before it reaches the renderer", () => {
    expect(projectSafeRun({
      status: "running",
      elapsedMs: 0,
      step: "inspecting",
      metadata: {
        agent: "Patchdesk review agent",
        model: "model",
        reasoning: "medium",
        mode: "Full review",
        access: "write access",
      },
    })).toEqual({ _tag: "err", error: { _tag: "InvalidRunProjection" } });

    expect(projectSafeRun({
      status: "running",
      elapsedMs: 0,
      step: "inspecting",
      activity: [{
        at: "not-a-time",
        elapsedMs: 0,
        step: "inspecting",
        label: "Inspecting files",
      }],
    })).toEqual({ _tag: "err", error: { _tag: "InvalidRunProjection" } });

    expect(projectSafeRun({
      status: "running",
      elapsedMs: 0,
      step: "inspecting",
      ignoredProviderPayload: "é".repeat(7_000),
    })).toEqual({ _tag: "err", error: { _tag: "InvalidRunProjection" } });
  });
});
