import type { CSSProperties } from "react";
import type { LineDiffTypes, SelectedLineRange } from "@pierre/diffs";

// Theme colors belong to the selected Pierre/Shiki descriptor. Patchdesk only
// owns the code metrics at this boundary so changing an independently saved
// light or dark theme changes both syntax and surface color as expected.
// SAFETY: every key below is a valid CSSProperties key with a valid CSS
// string value; the cast only widens the literal's inferred type.
const diffCodeMetrics = {
  fontSize: "13px",
  lineHeight: "20px",
  // Pierre's shadow-root stylesheet re-sets font-family on code elements, so
  // the stack must be handed over as the `--diffs-font-family` custom
  // property (custom properties cross the shadow boundary). `fontFamily`
  // still covers host-level text outside the shadow root.
  fontFamily: "var(--font-mono)",
  "--diffs-font-family": "var(--font-mono)",
} as CSSProperties;

export const DIFF_CODE_METRICS = diffCodeMetrics;

// @pierre/diffs' own default, named once for the three render call sites below.
export const DEFAULT_LINE_DIFF_TYPE: LineDiffTypes = "word-alt";

/**
 * Pierre's own gutter `+` opens the composer: a click selects one line and a
 * drag selects a range, which a custom `renderGutterUtility` cannot do (#552).
 * Line selection only highlights the dragged lines; it never opens a composer.
 */
export function gutterAuthoringOptions<TArgs extends ReadonlyArray<unknown>>(
  enabled: boolean,
  onGutterUtilityClick: (range: SelectedLineRange, ...rest: TArgs) => void,
) {
  return enabled
    ? {
        enableGutterUtility: true,
        enableLineSelection: true,
        onGutterUtilityClick,
      }
    : {};
}
