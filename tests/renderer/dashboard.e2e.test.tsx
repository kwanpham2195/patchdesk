// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "../../src/renderer/src/app";

describe("dashboard browser flow", () => {
  it("renders settings maintenance, direct entry, and degraded dashboard states without write actions", async () => {
    const user = userEvent.setup();
    render(<App initialState="degraded" />);

    expect(screen.getByText("Missing local path")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open pull request" }),
    ).toBeTruthy();
    expect(screen.queryByText(/Submit review|Merge pull request/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      screen.getByRole("heading", { name: "Watchlist settings" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Local path")).toBeTruthy();
  });

  it("requests confirmation before applying a suggested profile change", async () => {
    const user = userEvent.setup();
    render(<App initialState="success" />);
    await user.click(screen.getByRole("button", { name: "Open pull request" }));
    await user.type(
      screen.getByLabelText("Pull request reference"),
      "https://github.example.test/octo/service/pull/3",
    );
    await user.click(
      screen.getByRole("button", { name: "Preview pull request" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Switch workspace profile" }),
    ).toBeTruthy();
  });
});
