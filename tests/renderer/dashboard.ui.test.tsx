// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/renderer/src/app";
import { installDesktopDouble, success } from "./fake-desktop-response";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("dashboard renderer", () => {
  it("uses the current Review and Insight catalog requests", async () => {
    const desktop = installDesktopDouble(
      {
        "/v1/profiles": () =>
          success([
            {
              id: "cfw",
              label: "CFW",
              githubHost: "github.com",
              ghAccount: "fixture",
            },
          ]),
        "/v1/inbox": () => success({ rows: [], repos: [] }),
        "/v1/logs": () => success(null),
        "/v1/settings": () => success({}),
      },
      { operations: { setNavigationState: () => success({}) } },
    );
    render(<App />);
    await screen.findByRole("heading", { name: "Maintainer inbox" });
    const calls = requestedPaths(desktop);
    expect(calls).toContain("/v1/profiles");
    expect(calls).toContain("/v1/inbox?state=open&pageSize=25");
    expect(calls).not.toContain("/v1/reviews/models");
    desktop.restore();
  });
});

/** Every loopback path the renderer asked the bridge for, in call order. */
function requestedPaths(
  desktop: ReturnType<typeof installDesktopDouble>,
): readonly string[] {
  return desktop.request.mock.calls.flatMap(([input]) =>
    "path" in input ? [input.path] : [],
  );
}
