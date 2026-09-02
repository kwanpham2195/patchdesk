/** The ceilings the performance proof asserts and the expect timeout the browser suite waits with. */
export type TimingBudget = {
  readonly worstInteractionMs: number;
  readonly maximumGapMs: number;
  readonly scrollMaximumGapMs: number;
  readonly expectTimeoutMs: number;
};

const LOCAL_TIMING_BUDGET: TimingBudget = {
  worstInteractionMs: 200,
  maximumGapMs: 300,
  scrollMaximumGapMs: 100,
  expectTimeoutMs: 5_000,
};

// The macOS runner measured 205 to 302 ms against the 200 ms ceiling on
// 2026-09-02 with code that passed at 70 to 121 ms locally, so CI gets about
// double the local numbers and still fails a regression of that size.
const CI_TIMING_BUDGET: TimingBudget = {
  worstInteractionMs: 400,
  maximumGapMs: 600,
  scrollMaximumGapMs: 200,
  expectTimeoutMs: 15_000,
};

/** Picks the CI budget when `CI` is set to anything non-empty, the local budget otherwise. */
export function resolveTimingBudget(
  env: Readonly<Record<string, string | undefined>>,
): TimingBudget {
  return env.CI === undefined || env.CI === ""
    ? LOCAL_TIMING_BUDGET
    : CI_TIMING_BUDGET;
}

export const timingBudget = resolveTimingBudget(process.env);
