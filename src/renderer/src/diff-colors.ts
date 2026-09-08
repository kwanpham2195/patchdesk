/**
 * The added and removed colours for the diff surfaces Patchdesk paints itself.
 *
 * Pierre derives diff chrome from the selected Shiki theme, and some themes
 * use saturated terminal red and green that read badly in the dark line
 * gutters, so Patchdesk overrides them with this small GitHub-like semantic
 * palette. The override covers the walkthrough, the Brief hunk preview and the
 * Analysis evidence, plus the ```diff fence in a comment body. The Diff tab is
 * deliberately left out: it is the main reading surface, so its hues track
 * whichever diff theme the maintainer picks in Settings.
 *
 * These tokens do not adopt that theme's hues in turn because the surfaces
 * above render small text, where the Pierre hues measure as low as 2.28:1 on a
 * white card.
 *
 * The hues themselves live in `styles.css` as the `--diff-*` tokens, declared
 * once per theme, so a diff hue is written down in exactly one place and every
 * surface that spends one -- these overrides, the Tailwind `diff-*` utilities,
 * and the fence -- moves together when it changes.
 */
export const diffColors = {
  deletionText: "var(--diff-removed-fg)",
  additionText: "var(--diff-added-fg)",
  deletionNumber: "var(--diff-removed-number)",
  additionNumber: "var(--diff-added-number)",
  deletionBackground: "var(--diff-removed-bg)",
  additionBackground: "var(--diff-added-bg)",
  deletionEmphasis: "var(--diff-removed-emphasis)",
  additionEmphasis: "var(--diff-added-emphasis)",
} as const;

/**
 * The same palette as `unsafeCSS` for a `@pierre/diffs` custom element. The
 * `var()`s resolve against the document root rather than the host, because
 * custom properties inherit through the shadow boundary.
 */
export const pierreDiffColorsCss = `
:host {
  --diffs-deletion-color-override: ${diffColors.deletionText};
  --diffs-addition-color-override: ${diffColors.additionText};
  --diffs-fg-number-deletion-override: ${diffColors.deletionNumber};
  --diffs-fg-number-addition-override: ${diffColors.additionNumber};
  --diffs-bg-deletion-override: ${diffColors.deletionBackground};
  --diffs-bg-addition-override: ${diffColors.additionBackground};
  --diffs-bg-deletion-emphasis-override: ${diffColors.deletionEmphasis};
  --diffs-bg-addition-emphasis-override: ${diffColors.additionEmphasis};
}
`;
