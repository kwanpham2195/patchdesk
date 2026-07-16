import { describe, expect, it } from "vitest";
import { ReviewRunRegistry } from "../../src/services/review-run-registry";

describe("review run registry", () => {
  it("rejects a run read from another session or attempt", () => {
    const registry = new ReviewRunRegistry();
    const run = registry.create({ sessionId: "one", attemptId: "001" });
    expect(registry.get(run.runId, { sessionId: "one", attemptId: "001" })).toMatchObject({ _tag: "ok" });
    expect(registry.get(run.runId, { sessionId: "two", attemptId: "001" })).toEqual({ _tag: "err", error: { _tag: "RunNotOwned" } });
  });

  it("projects only coarse lifecycle states for its owned run", () => {
    const registry = new ReviewRunRegistry();
    const run = registry.create({ sessionId: "one", attemptId: "001" });

    registry.update(run.runId, { status: "running", elapsedMs: 12, step: "inspecting" });

    expect(registry.get(run.runId, { sessionId: "one", attemptId: "001" })).toEqual({
      _tag: "ok",
      value: { ...run, projection: { status: "running", elapsedMs: 12, step: "inspecting" } },
    });
  });
});
