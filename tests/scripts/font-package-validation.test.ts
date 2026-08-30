import { describe, expect, it } from "vitest";

import {
  validatePackagedFontRuntime,
  validateRendererFontBundle,
} from "../../scripts/font-package-validation.mjs";

const expectedAssets = [
  "assets/geist-latin-wght-normal-a.woff2",
  "assets/inter-latin-wght-normal-b.woff2",
  "assets/geist-mono-latin-wght-normal-c.woff2",
];
const expectedCss = `
  @font-face { font-family: "Geist Variable"; }
  @font-face { font-family: Inter Variable; }
  @font-face { font-family: "Geist Mono Variable"; }
`;

describe("validateRendererFontBundle", () => {
  it("accepts the three bundled font families after Ioskeley removal", () => {
    expect(validateRendererFontBundle(expectedAssets, expectedCss)).toEqual([]);
  });

  it("reports missing expected assets and stale Ioskeley output", () => {
    expect(
      validateRendererFontBundle(
        [
          "assets/inter-latin-wght-normal-b.woff2",
          "assets/IoskeleyMono-Regular-deadbeef.woff2",
        ],
        `${expectedCss.replace('font-family: "Geist Mono Variable";', "")}\nfont-family: "Ioskeley Mono";`,
      ),
    ).toEqual([
      "Renderer bundle has no Geist font asset.",
      "Renderer bundle has no Geist Mono font asset.",
      'Renderer CSS has no "Geist Mono Variable" family.',
      "Renderer bundle still contains Ioskeley.",
    ]);
  });

  it("reports a missing bundled Inter fallback", () => {
    expect(
      validateRendererFontBundle(
        expectedAssets.filter((asset) => !asset.includes("inter-")),
        expectedCss.replace("font-family: Inter Variable;", ""),
      ),
    ).toEqual([
      "Renderer bundle has no Inter font asset.",
      'Renderer CSS has no "Inter Variable" family.',
    ]);
  });
});

describe("validatePackagedFontRuntime", () => {
  const expectedRuntime = {
    bodyFontFamily:
      '"Geist Variable", Geist, "Inter Variable", Inter, ui-sans-serif',
    codeFontFamily:
      '"Geist Mono Variable", "Geist Mono", ui-monospace, monospace',
    fontFaces: [
      { family: "Geist Variable", status: "loaded" },
      { family: "Geist Mono Variable", status: "loaded" },
      { family: "Inter Variable", status: "unloaded" },
    ],
    loadedGeistFaces: 1,
    loadedGeistMonoFaces: 1,
    fontResourceFailures: [],
  } as const;

  it("accepts loaded primary fonts and a registered Inter fallback", () => {
    expect(validatePackagedFontRuntime(expectedRuntime)).toEqual([]);
  });

  it("rejects fallback rendering, failed resources, and stale Ioskeley faces", () => {
    expect(
      validatePackagedFontRuntime({
        ...expectedRuntime,
        bodyFontFamily: '"Inter Variable", Inter, sans-serif',
        codeFontFamily: '"Ioskeley Mono", monospace',
        fontFaces: [{ family: "Ioskeley Mono", status: "loaded" }],
        loadedGeistFaces: 0,
        loadedGeistMonoFaces: 0,
        fontResourceFailures: ["font request failed: geist.woff2"],
      }),
    ).toEqual([
      'Packaged body does not prefer "Geist Variable".',
      'Packaged code does not prefer "Geist Mono Variable".',
      'Packaged FontFaceSet has no loaded "Geist Variable" face.',
      'Packaged FontFaceSet has no loaded "Geist Mono Variable" face.',
      'Packaged FontFaceSet has no registered "Inter Variable" face.',
      "Packaged FontFaceSet still contains Ioskeley.",
      "Packaged renderer had font resource failures: font request failed: geist.woff2",
    ]);
  });
});
