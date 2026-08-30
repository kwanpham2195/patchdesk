import { describe, expect, it } from "vitest";

import { scanRendererErrorSurfaceSources } from "../../scripts/check-renderer-error-surfaces.mjs";

const approvedPrimitiveSources = [
  {
    path: "src/renderer/src/components/ui/alert.tsx",
    source: 'export const Alert = () => <div role="alert" />;',
  },
  {
    path: "src/renderer/src/components/ui/field.tsx",
    source: "export const FieldError = () => <div role={'alert'} />;",
  },
  {
    path: "src/renderer/src/components/ui/inline-error.tsx",
    source: "export const InlineError = () => <p role='alert' />;",
  },
];

describe("scanRendererErrorSurfaceSources", () => {
  it("allows literal alert roles only in the approved renderer primitives", () => {
    expect(scanRendererErrorSurfaceSources(approvedPrimitiveSources)).toEqual(
      [],
    );
  });

  it("reports every raw production alert with its path and line", () => {
    const violations = scanRendererErrorSurfaceSources([
      ...approvedPrimitiveSources,
      {
        path: "src/renderer/src/components/example.tsx",
        source: [
          "export function Example() {",
          '  return <p role="alert">Failure</p>;',
          "}",
        ].join("\n"),
      },
      {
        path: "src/renderer/src/flows/example.tsx",
        source: [
          "const role = 'status';",
          "const raw = <div role={'alert'} />;",
        ].join("\n"),
      },
    ]);

    expect(violations).toEqual([
      {
        path: "src/renderer/src/components/example.tsx",
        line: 2,
      },
      {
        path: "src/renderer/src/flows/example.tsx",
        line: 2,
      },
    ]);
  });
});
