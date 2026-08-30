const EXPECTED_BUNDLE_FAMILIES = [
  "Geist Variable",
  "Inter Variable",
  "Geist Mono Variable",
];

/**
 * Validates the emitted renderer font closure without reading the filesystem.
 *
 * @param {ReadonlyArray<string>} assetFileNames
 * @param {string} cssSource
 * @returns {ReadonlyArray<string>}
 */
export function validateRendererFontBundle(assetFileNames, cssSource) {
  const errors = [];
  const normalizedAssets = assetFileNames.map((fileName) =>
    fileName.toLowerCase(),
  );
  if (
    !normalizedAssets.some((fileName) => /(^|\/)geist-(?!mono-)/.test(fileName))
  )
    errors.push("Renderer bundle has no Geist font asset.");
  if (!normalizedAssets.some((fileName) => /(^|\/)inter-/.test(fileName)))
    errors.push("Renderer bundle has no Inter font asset.");
  if (!normalizedAssets.some((fileName) => /(^|\/)geist-mono-/.test(fileName)))
    errors.push("Renderer bundle has no Geist Mono font asset.");

  for (const family of EXPECTED_BUNDLE_FAMILIES) {
    const familyDeclaration = new RegExp(
      `font-family\\s*:\\s*["']?${family}["']?`,
    );
    if (!familyDeclaration.test(cssSource))
      errors.push(`Renderer CSS has no "${family}" family.`);
  }
  if (
    normalizedAssets.some((fileName) => fileName.includes("ioskeley")) ||
    cssSource.toLowerCase().includes("ioskeley")
  )
    errors.push("Renderer bundle still contains Ioskeley.");
  return errors;
}

/**
 * Validates observable font state captured from the packaged Chromium renderer.
 *
 * @param {{
 *   readonly bodyFontFamily: string;
 *   readonly codeFontFamily: string;
 *   readonly fontFaces: ReadonlyArray<{ readonly family: string; readonly status: string }>;
 *   readonly loadedGeistFaces: number;
 *   readonly loadedGeistMonoFaces: number;
 *   readonly fontResourceFailures: ReadonlyArray<string>;
 * }} runtime
 * @returns {ReadonlyArray<string>}
 */
export function validatePackagedFontRuntime(runtime) {
  const errors = [];
  if (!runtime.bodyFontFamily.trim().startsWith('"Geist Variable"'))
    errors.push('Packaged body does not prefer "Geist Variable".');
  if (!runtime.codeFontFamily.trim().startsWith('"Geist Mono Variable"'))
    errors.push('Packaged code does not prefer "Geist Mono Variable".');
  if (runtime.loadedGeistFaces === 0)
    errors.push('Packaged FontFaceSet has no loaded "Geist Variable" face.');
  if (runtime.loadedGeistMonoFaces === 0)
    errors.push(
      'Packaged FontFaceSet has no loaded "Geist Mono Variable" face.',
    );
  if (!runtime.fontFaces.some((face) => face.family === "Inter Variable"))
    errors.push(
      'Packaged FontFaceSet has no registered "Inter Variable" face.',
    );
  if (
    runtime.fontFaces.some((face) =>
      face.family.toLowerCase().includes("ioskeley"),
    )
  )
    errors.push("Packaged FontFaceSet still contains Ioskeley.");
  if (runtime.fontResourceFailures.length > 0)
    errors.push(
      `Packaged renderer had font resource failures: ${runtime.fontResourceFailures.join("; ")}`,
    );
  return errors;
}
