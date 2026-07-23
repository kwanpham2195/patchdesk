import { describe, expect, it } from "vitest";

import { projectSafeRun } from "../../src/services/run-projection";

describe("safe Flue run projection", () => {
  it("exposes only whitelisted live state", () => {
    expect(projectSafeRun({
      status: "running",
      elapsedMs: 4,
      step: "inspecting",
      message: "Reading changed files",
      prompt: "secret",
    })).toEqual({ _tag: "err", error: { _tag: "InvalidRunProjection" } });
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
});
