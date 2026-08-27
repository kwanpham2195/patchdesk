// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/renderer/src/app";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("dashboard renderer", () => {
  it("uses the current Review and Insight catalog requests", async () => {
    const calls: string[] = [];
    Object.defineProperty(window, "patchdesk", {
      value: {
        request: async (input: { path?: string }) => {
          calls.push(input.path ?? "");
          if (input.path === "/v1/profiles")
            return {
              ok: true,
              status: 200,
              body: [
                {
                  id: "cfw",
                  label: "CFW",
                  githubHost: "github.com",
                  ghAccount: "fixture",
                },
              ],
              correlationId: "x",
            };
          if (input.path === "/v1/dashboard")
            return {
              ok: true,
              status: 200,
              body: { rows: [], repos: [] },
              correlationId: "x",
            };
          if (input.path === "/v1/insight-providers")
            return {
              ok: true,
              status: 200,
              body: { providers: [] },
              correlationId: "x",
            };
          return { ok: true, status: 200, body: {}, correlationId: "x" };
        },
        onMenuAction: () => () => undefined,
      },
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Maintainer inbox" });
    expect(calls).toContain("/v1/profiles");
    expect(calls).toContain("/v1/inbox?state=open&pageSize=25");
    expect(calls).not.toContain("/v1/reviews/models");
  });
});
