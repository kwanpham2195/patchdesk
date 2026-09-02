import { describe, expect, it } from "vitest";

import { resolveTimingBudget } from "./timing-budget";

const localBudget = {
  worstInteractionMs: 200,
  maximumGapMs: 300,
  scrollMaximumGapMs: 100,
  expectTimeoutMs: 5_000,
};

const ciBudget = {
  worstInteractionMs: 400,
  maximumGapMs: 600,
  scrollMaximumGapMs: 200,
  expectTimeoutMs: 15_000,
};

describe("resolveTimingBudget", () => {
  it("uses the local budget when CI is unset", () => {
    expect(resolveTimingBudget({})).toEqual(localBudget);
  });

  it("uses the CI budget when CI is set", () => {
    expect(resolveTimingBudget({ CI: "true" })).toEqual(ciBudget);
  });

  it("uses the local budget when CI is empty", () => {
    expect(resolveTimingBudget({ CI: "" })).toEqual(localBudget);
  });
});
