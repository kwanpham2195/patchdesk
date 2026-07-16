// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/src/app";

const dashboard = {
  profile: {
    id: "cfw",
    label: "CFW",
    githubHost: "github.com",
    ghAccount: "pmquan2cfw",
  },
  dashboard: {
    rows: [
      {
        summary: {
          ref: { number: 42 },
          title: "Real dashboard row",
          author: "reviewer",
          checkSummary: { overall: "passing" },
        },
        priority: "review_requested",
        badges: ["review requested"],
      },
    ],
    repos: [
      {
        repo: {
          host: "github.com",
          owner: "centraldigital",
          repo: "patchdesk",
        },
        state: "ready",
      },
      {
        repo: {
          host: "github.com",
          owner: "centraldigital",
          repo: "archived",
          archived: true,
        },
        state: "archived",
      },
    ],
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("dashboard renderer API flow", () => {
  it("loads profile, watchlist, rows, and archived outcome from authenticated API responses", async () => {
    installApi();
    render(<App />);
    expect(await screen.findByText(/Real dashboard row/)).toBeTruthy();
    expect(screen.getByText("centraldigital/patchdesk")).toBeTruthy();
    expect(screen.getByText(/Archived repository/)).toBeTruthy();
    expect(screen.queryByText(/Submit review|Merge pull request/i)).toBeNull();
  });

  it("uses the server preview target before selecting and opening a direct PR", async () => {
    const fetch = installApi();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(/Real dashboard row/);
    await user.type(
      screen.getByLabelText("Pull request reference"),
      "octo/service#3",
    );
    await user.click(
      screen.getByRole("button", { name: "Preview pull request" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Switch workspace profile" }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", {
        name: "Switch profile and open pull request",
      }),
    );
    expect(
      fetch.mock.calls.some(
        ([input, init]) =>
          String(input).includes("v1/profiles/select") &&
          (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(true);
  });

  it("opens a normal direct entry immediately and lets users keep their current profile", async () => {
    const fetch = installApi({ confirmationRequired: false });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(/Real dashboard row/);
    await user.type(
      screen.getByLabelText("Pull request reference"),
      "octo/service#3",
    );
    await user.click(
      screen.getByRole("button", { name: "Preview pull request" }),
    );
    expect(await screen.findByText("Opened octo/service#3")).toBeTruthy();
    expect(
      fetch.mock.calls.some(([input]) =>
        String(input).includes("v1/profiles/select"),
      ),
    ).toBe(false);
  });
});

function installApi(
  options: { readonly confirmationRequired?: boolean } = {},
): ReturnType<typeof vi.fn> {
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: {
      localApi: {
        baseUrl: "http://patchdesk.local/",
        capability: "capability",
      },
    },
  });
  const fetch = vi.fn(async (input: URL | string) => {
    const path = String(input);
    const body =
      path.includes("v1/profiles") && !path.includes("select")
        ? [
            {
              id: "cfw",
              label: "CFW",
              githubHost: "github.com",
              ghAccount: "pmquan2cfw",
            },
            {
              id: "enterprise",
              label: "Enterprise",
              githubHost: "github.example.test",
              ghAccount: "enterprise-user",
            },
          ]
        : path.includes("direct-entry")
          ? {
              pr: { owner: "octo", repo: "service", number: 3 },
              confirmation: {
                required: options.confirmationRequired ?? true,
                targetProfileId: "enterprise",
              },
            }
          : dashboard;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
