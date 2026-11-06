// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MarkdownFilePreview } from "#src/renderer/src/components/markdown-file-preview";

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
beforeEach(() => {
  // jsdom lacks the font readiness API used before measuring diagram labels.
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
});
afterEach(() => {
  cleanup();
  if (originalFonts === undefined) Reflect.deleteProperty(document, "fonts");
  else Object.defineProperty(document, "fonts", originalFonts);
});

describe("MarkdownFilePreview Mermaid fences", () => {
  it("draws a valid fence as a diagram", async () => {
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
