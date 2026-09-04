/**
 * The added and removed colours every diff surface shares.
 *
 * Pierre derives diff chrome from the selected Shiki theme, and some themes
 * use saturated terminal red and green that read badly in the dark line
 * gutters, so Patchdesk overrides them with this small GitHub-like semantic
 * palette. A ```diff fence in a comment body uses the same values, so the
 * same change is the same colour wherever a reviewer meets it.
 *
 * `light-dark()` resolves against `color-scheme`, which `applyAppearance`
 * sets on the root element from the user's own choice, so these follow the
 * app's appearance rather than the operating system's.
 */
export const diffColors = {
  deletionText: "light-dark(#cf222e, #f85149)",
  additionText: "light-dark(#1a7f37, #3fb950)",
  deletionNumber: "light-dark(#cf222e, #ff7b72)",
  additionNumber: "light-dark(#1a7f37, #7ee787)",
  deletionBackground: "light-dark(#ffebe9, #3d1d1d)",
  additionBackground: "light-dark(#dafbe1, #1f3a26)",
  deletionEmphasis:
    "light-dark(rgb(255 129 130 / 0.28), rgb(248 81 73 / 0.22))",
  additionEmphasis: "light-dark(rgb(46 160 67 / 0.28), rgb(46 160 67 / 0.22))",
} as const;

/** The same palette as `unsafeCSS` for a `@pierre/diffs` custom element. */
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
