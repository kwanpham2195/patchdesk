import type { ChangeScopeBucket } from "../../../domain/change-scope";

/** The one label each bucket carries wherever it is named: the gauge's legend rows, its accessible sentence, and the diff toolbar's filter chip. */
export const SCOPE_BUCKET_LABELS = {
  core: "Core",
  tests: "Tests",
  generated: "Generated",
  docs: "Docs",
  config: "Config",
} satisfies Record<ChangeScopeBucket, string>;

/**
 * Each bucket's fill class, written out in full because Tailwind reads class
 * names as literal source text; a composed `bg-[var(--scope-${bucket})]`
 * would never be generated. `generated` is a diagonal hatch (see
 * `.scope-gauge-hatch` in `styles.css`) so its share reads as "not
 * hand-written" without spending a sixth hue on it.
 */
export const SCOPE_BUCKET_FILLS = {
  core: "bg-[var(--scope-core)]",
  tests: "bg-[var(--scope-tests)]",
  generated: "scope-gauge-hatch",
  docs: "bg-[var(--scope-docs)]",
  config: "bg-[var(--scope-config)]",
} satisfies Record<ChangeScopeBucket, string>;
