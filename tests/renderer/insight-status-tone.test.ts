import { describe, expect, it } from "vitest";

import { insightStatusTone } from "../../src/renderer/src/insight-status-tone";

describe("insightStatusTone", () => {
  it("reads Current alone as success, since only it navigates live code", () => {
    expect(insightStatusTone("current")).toBe("success");
  });

  it("warns on Outdated rather than failing it, since the evidence stays readable", () => {
    expect(insightStatusTone("outdated")).toBe("warning");
  });

  it("keeps Running neutral and marks Failed destructive", () => {
    expect(insightStatusTone("running")).toBe("secondary");
    expect(insightStatusTone("failed")).toBe("destructive");
  });

  it("outlines Not generated as an option not yet taken", () => {
    expect(insightStatusTone("not_generated")).toBe("outline");
  });
});
