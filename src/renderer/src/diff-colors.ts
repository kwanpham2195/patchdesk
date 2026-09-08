/**
 * The added and removed colours every diff surface shares.
 *
 * Pierre derives diff chrome from the selected Shiki theme, and some themes
 * use saturated terminal red and green that read badly in the dark line
 * gutters, so Patchdesk overrides them with this small GitHub-like semantic
 * palette. A ```diff fence in a comment body uses the same values, so the
 * same change is the same colour wherever a reviewer meets it.
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
