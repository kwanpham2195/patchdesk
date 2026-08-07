// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Conversation } from "../../src/renderer/src/components/conversation";

afterEach(cleanup);

describe("Conversation", () => {
  it("does not present a populated pull request description as an empty conversation", () => {
    render(
      <Conversation
        conversation={{
          prDescription: "# What happened\n\n- Changed the route-planning solver.",
          entries: [],
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "What happened" })).toBeTruthy();
    expect(screen.getByText("Changed the route-planning solver.")).toBeTruthy();
    expect(screen.queryByText("No conversation yet.")).toBeNull();
  });
});
