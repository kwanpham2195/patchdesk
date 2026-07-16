// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "../src/renderer/src/app";

describe("Patchdesk dashboard scaffold", () => {
  it("shows a useful empty review workbench", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Patchdesk" })).toBeTruthy();
    expect(
      screen.getByText("Open a pull request to begin a local review."),
    ).toBeTruthy();
  });
});
