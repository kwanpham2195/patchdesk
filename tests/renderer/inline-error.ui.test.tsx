// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { InlineError } from "../../src/renderer/src/components/ui/inline-error";

afterEach(cleanup);

describe("InlineError", () => {
  it("forces the shared action-local alert semantics", () => {
    render(<InlineError role="status">Action failed</InlineError>);

    const error = screen.getByRole("alert");
    expect(error.tagName).toBe("P");
    expect(error.getAttribute("data-slot")).toBe("inline-error");
  });
});
