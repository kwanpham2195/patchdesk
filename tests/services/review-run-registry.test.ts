import { describe, expect, it } from "vitest";
import { ReviewRunRegistry } from "../../src/services/review-run-registry";
describe("review run registry", () => { it("rejects a run read from another session or attempt", () => { const registry = new ReviewRunRegistry(); const run = registry.create({ sessionId: "one", attemptId: "001" }); expect(registry.get(run.runId, { sessionId: "one", attemptId: "001" })).toMatchObject({ _tag: "ok" }); expect(registry.get(run.runId, { sessionId: "two", attemptId: "001" })).toEqual({ _tag: "err", error: { _tag: "RunNotOwned" } }); }); });
