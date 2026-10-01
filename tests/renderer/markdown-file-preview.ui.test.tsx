// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MarkdownFilePreview } from "../../src/renderer/src/components/markdown-file-preview";

afterEach(cleanup);

function stubSvgMeasurement(): () => void {
  const originalGetBBox = Object.getOwnPropertyDescriptor(
    SVGElement.prototype,
    "getBBox",
  );
  const originalGetComputedTextLength = Object.getOwnPropertyDescriptor(
    SVGElement.prototype,
    "getComputedTextLength",
  );
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 100, height: 30 }),
  });
  Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
    configurable: true,
    value: () => 100,
  });
  return () => {
    if (originalGetBBox === undefined) {
      Reflect.deleteProperty(SVGElement.prototype, "getBBox");
    } else {
      Object.defineProperty(SVGElement.prototype, "getBBox", originalGetBBox);
    }
    if (originalGetComputedTextLength === undefined) {
      Reflect.deleteProperty(SVGElement.prototype, "getComputedTextLength");
    } else {
      Object.defineProperty(
        SVGElement.prototype,
        "getComputedTextLength",
        originalGetComputedTextLength,
      );
    }
  };
}

describe("MarkdownFilePreview Mermaid fences", () => {
  it("draws a valid fence as a diagram", async () => {
    const restore = stubSvgMeasurement();
    try {
      render(
        <MarkdownFilePreview
          markdown={"```mermaid\ngraph TD\n  A[Start] --> B[Review]\n```"}
          path="docs/architecture.md"
        />,
      );

      expect(
        await screen.findByRole("button", { name: "Mermaid diagram" }),
      ).toBeTruthy();
      expect(screen.getByText("Mermaid source")).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("shows the notice and the source for a fence Mermaid cannot parse", async () => {
    render(
      <MarkdownFilePreview
        markdown={"```mermaid\nnot a diagram ->>\n```"}
        path="docs/architecture.md"
      />,
    );

    expect(
      await screen.findByText("Mermaid could not render this diagram."),
    ).toBeTruthy();
    expect(screen.getByText(/not a diagram/)).toBeTruthy();
  });
});
