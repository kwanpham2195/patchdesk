import { describe, expect, it } from "vitest";
import { projectSafeRun } from "../../src/services/run-projection";
describe("safe Flue run projection", () => { it("exposes only whitelisted live state", () => { expect(projectSafeRun({ status: "running", elapsedMs: 4, step: "inspecting", message: "Reading changed files", prompt: "secret" })).toEqual({ _tag: "err", error: { _tag: "InvalidRunProjection" } }); expect(projectSafeRun({ status: "disconnected", elapsedMs: 4, step: "inspecting" })).toMatchObject({ _tag: "ok" }); }); });
