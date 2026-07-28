// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AppShell } from "../../src/renderer/src/components/app-shell";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AppShell settings layout", () => {
  it("gives the settings destination a vertical scroll owner", () => {
    render(
      <AppShell
        destination={{ kind: "settings" }}
        profileId="cfw"
        profileLabel="CFW"
        repositoryCount={0}
        onNavigate={() => undefined}
      >
        <div>Settings content</div>
      </AppShell>,
    );

    expect(screen.getByRole("main").className).toContain("overflow-y-auto");
  });
});
