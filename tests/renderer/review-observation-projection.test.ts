import { describe, expect, it } from "vitest";

import { reconciledProjection } from "../../src/renderer/src/flows/review-observation-projection";
import { projection } from "./review-workbench-fixtures";

describe("reconciledProjection", () => {
  it("reports a Reconciled observation without a projection as absent", () => {
    expect(reconciledProjection({})).toEqual({ _tag: "absent" });
  });

  it("reports a present but malformed projection as invalid", () => {
    expect(reconciledProjection({ projection: { detected: "yes" } })).toEqual({
      _tag: "invalid",
    });
  });

  it("parses a present, well-formed projection", () => {
    const workbench = projection();
    expect(reconciledProjection({ projection: workbench })).toEqual({
      _tag: "parsed",
      workbench,
    });
  });
});
