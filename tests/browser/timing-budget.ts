/** The ceilings the performance proof asserts and the expect timeout the browser suite waits with. */
export type TimingBudget = {
  readonly worstInteractionMs: number;
  readonly maximumGapMs: number;
  readonly scrollMaximumGapMs: number;
  readonly expectTimeoutMs: number;
};

// Selection is timed in the page from pointerdown to the `data-selected-path`
// commit; filter is timed from Node, `fill` to the treeitem being visible.
// On 2026-09-15 (Apple M2 Pro, 10 cores, headless Chromium 149.0.7827.55,
// load1 3.4 to 4.3) ten runs measured selection worst 23 to 31 ms and filter
// worst 20 to 54 ms, so these ceilings leave room for a loaded machine.
const LOCAL_TIMING_BUDGET: TimingBudget = {
  worstInteractionMs: 200,
  maximumGapMs: 300,
  scrollMaximumGapMs: 100,
  expectTimeoutMs: 5_000,
};

// The macOS runner's 205 to 302 ms on 2026-09-02 timed selection from Node
// across Playwright's click retries, so it is not comparable with the in-page
// number; these ceilings stay until a `CI=1` run records in-page numbers.
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
