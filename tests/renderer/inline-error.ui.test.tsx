// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Alert } from "../../src/renderer/src/components/ui/alert";
import { InlineError } from "../../src/renderer/src/components/ui/inline-error";

afterEach(cleanup);

describe("InlineError", () => {
  it("forces the shared action-local alert semantics and merges caller styling", () => {
    render(
      <InlineError role="status" className="mt-2">
        Action failed
      </InlineError>,
    );

    const error = screen.getByRole("alert");
    expect(error.tagName).toBe("P");
    expect(error.getAttribute("data-slot")).toBe("inline-error");
    expect(error.className).toContain("text-sm");
    expect(error.className).toContain("text-destructive");
    expect(error.className).toContain("mt-2");
  });
});

describe("Alert status variants", () => {
  it.each([
    ["info", "status-info"],
    ["warning", "status-warning"],
    ["success", "status-success"],
  ] as const)("uses the %s semantic status token", (variant, token) => {
    render(<Alert variant={variant}>{variant}</Alert>);

    const alert = screen.getByRole("alert");
    expect(alert.className).toContain(token);
    cleanup();
  });
});
