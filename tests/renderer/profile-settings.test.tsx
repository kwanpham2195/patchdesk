// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsFlow } from "../../src/renderer/src/flows/settings-flow";

const profile = {
  id: "cfw",
  label: "CFW",
  githubHost: "github.com",
  ghAccount: "patchdesk",
  workspaceRoots: ["/workspace/cfw"],
  ownerFilters: ["centraldigital"],
  rulePaths: ["/workspace/cfw/AGENTS.md"],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("workspace profile settings", () => {
  it("creates a selected profile with every editable profile list", async () => {
    const request = installDesktopApi();
    const user = userEvent.setup();
    const reload = vi.fn(async () => undefined);

    renderSettings(reload);

    expect(screen.getByLabelText("Profile ID").hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByRole("button", { name: "New profile" }));
    expect(screen.getByLabelText("Profile ID").hasAttribute("disabled")).toBe(false);

    await user.type(screen.getByLabelText("Profile ID"), "enterprise");
    await user.type(screen.getByLabelText("Label"), "Enterprise");
    await user.clear(screen.getByLabelText("GitHub host"));
    await user.type(screen.getByLabelText("GitHub host"), "github.example.test");
    await user.type(screen.getByLabelText("GitHub account"), "enterprise-user");
    await user.type(screen.getByLabelText("workspace root 1"), "/workspace/enterprise");
    await user.click(screen.getByRole("button", { name: "Add workspace root" }));
    await user.click(screen.getByRole("button", { name: "Choose workspace root 2" }));
    await user.click(screen.getByRole("button", { name: "Remove workspace root 1" }));
    await user.type(screen.getByLabelText("owner filter 1"), "enterprise");
    await user.click(screen.getByRole("button", { name: "Add rule path" }));
    await user.type(screen.getByLabelText("rule path 1"), "/workspace/enterprise/AGENTS.md");
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        path: "/v1/profiles",
        method: "POST",
        body: {
          id: "enterprise",
          label: "Enterprise",
          githubHost: "github.example.test",
          ghAccount: "enterprise-user",
          workspaceRoots: ["/picked/enterprise"],
          ownerFilters: ["enterprise"],
          rulePaths: ["/workspace/enterprise/AGENTS.md"],
        },
      }),
    );
    expect(request).toHaveBeenCalledWith({
      path: "/v1/profiles/select",
      method: "POST",
      body: { id: "enterprise" },
    });
    expect(reload).toHaveBeenCalled();
  });

  it("shows inline validation for a blank list entry without saving", async () => {
    const request = installDesktopApi();
    const user = userEvent.setup();

    renderSettings();
    await user.click(screen.getByRole("button", { name: "Add owner filter" }));
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    expect(
      screen.getByText("Owner filters cannot contain blank entries."),
    ).toBeTruthy();
    expect(
      request.mock.calls.some(([input]) => input.path === "/v1/profiles"),
    ).toBe(false);
  });

  it("shows a save error inline when the profile API rejects the request", async () => {
    const request = installDesktopApi({ rejectProfileSave: true });
    const user = userEvent.setup();

    renderSettings();
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    expect(await screen.findByText("Patchdesk could not save the local review state.")).toBeTruthy();
    expect(
      request.mock.calls.some(([input]) => input.path === "/v1/profiles"),
    ).toBe(true);
  });

  it("renders the storage sections and requires a confirmation before discarding a saved review", async () => {
    const request = installStorageDesktopApi();
    const user = userEvent.setup();

    renderSettings();
    await waitFor(() =>
      expect(request.mock.calls.some(
        ([input]) =>
          typeof input.path === "string" &&
          input.path.startsWith("/v1/storage") &&
          (input.method ?? "GET") === "GET",
      )).toBe(true),
    );

    expect(screen.getByText("Saved reviews")).toBeTruthy();
    expect(screen.getByText("Older-version saved reviews")).toBeTruthy();
    expect(screen.getByText("Review cache")).toBeTruthy();
    expect(screen.getByText("centraldigital/patchdesk#42")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Discard centraldigital/patchdesk#42" }));
    expect(
      request.mock.calls.some(([input]) => input.path === "/v1/storage/discard"),
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "Confirm discard" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        path: "/v1/storage/discard",
        method: "POST",
        body: { profileId: "cfw", sessionId: "session-1" },
      }),
    );
  });

  it("hides the discard control for a running session and requires confirmation for delete and clear", async () => {
    const request = installStorageDesktopApi();
    const user = userEvent.setup();

    renderSettings();
    await waitFor(() =>
      expect(request.mock.calls.some(
        ([input]) =>
          typeof input.path === "string" &&
          input.path.startsWith("/v1/storage") &&
          (input.method ?? "GET") === "GET",
      )).toBe(true),
    );

    expect(
      screen.queryByRole("button", { name: "Discard centraldigital/patchdesk#99" }),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "Delete older review" }));
    expect(
      request.mock.calls.some(
        ([input]) => input.path === "/v1/storage/quarantine/delete",
      ),
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        path: "/v1/storage/quarantine/delete",
        method: "POST",
        body: { profileId: "cfw", entryName: "old.20260101T000000" },
      }),
    );

    await user.click(screen.getByRole("button", { name: "Clear review cache" }));
    expect(
      request.mock.calls.some(([input]) => input.path === "/v1/storage/cache/clear"),
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "Confirm clear cache" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        path: "/v1/storage/cache/clear",
        method: "POST",
        body: { profileId: "cfw" },
      }),
    );
  });
});

function renderSettings(onWorkspaceReload = async (): Promise<void> => undefined): void {
  render(
    <SettingsFlow
      dashboard={{ profile, dashboard: { rows: [], repos: [] } }}
      appearance="system"
      onAppearanceChange={() => undefined}
      diffThemePreferences={{ light: "pierre-light", dark: "github-dark" }}
      onDiffThemeChange={() => undefined}
      profiles={[profile]}
      onWorkspaceReload={onWorkspaceReload}
      onRepositoryRefresh={() => undefined}
    />,
  );
}

function installDesktopApi(options: { readonly rejectProfileSave?: boolean } = {}): ReturnType<typeof vi.fn> {
  const request = vi.fn(async (input: {
    readonly path?: string;
    readonly method?: string;
    readonly body?: unknown;
    readonly operation?: string;
  }) => {
    if (input.operation === "selectDirectory") return success({ path: "/picked/enterprise" });
    if (input.path === "/v1/environment") return success({});
    if (input.path === "/v1/profiles" && options.rejectProfileSave === true)
      return failure({ error: "storage" });
    return success({});
  });
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: { request, onNavigate: () => () => undefined },
  });
  return request;
}

function installStorageDesktopApi(): ReturnType<typeof vi.fn> {
  const request = vi.fn(async (input: {
    readonly path?: string;
    readonly method?: string;
    readonly body?: unknown;
    readonly operation?: string;
  }) => {
    if (input.path === "/v1/environment") return success({});
    if (input.path !== undefined && input.path.startsWith("/v1/storage") && (input.method ?? "GET") === "GET" && !input.path.includes("/discard") && !input.path.includes("/delete") && !input.path.includes("/clear")) {
      return success({
        sessions: [
          {
            id: "session-1",
            prLabel: "centraldigital/patchdesk#42",
            state: "ReviewCompleted",
            updatedAt: "2026-07-16T00:00:00.000Z",
            canDiscard: true,
          },
          {
            id: "session-2",
            prLabel: "centraldigital/patchdesk#99",
            state: "Running",
            updatedAt: "2026-07-16T00:01:00.000Z",
            canDiscard: false,
          },
        ],
        quarantined: [
          { entryName: "old.20260101T000000", quarantinedAt: "2026-01-01T00:00:00.000Z" },
        ],
        cacheBytes: 1234,
      });
    }
    if (input.path === "/v1/storage/discard") return success({});
    if (input.path === "/v1/storage/quarantine/delete") return success({});
    if (input.path === "/v1/storage/cache/clear") return success({});
    return success({});
  });
  Object.defineProperty(window, "patchdesk", {
    configurable: true,
    value: { request, onNavigate: () => () => undefined },
  });
  return request;
}

function success(body: unknown): {
  readonly ok: true;
  readonly status: 200;
  readonly body: unknown;
  readonly correlationId: string;
} {
  return { ok: true, status: 200, body, correlationId: "test" };
}

function failure(body: unknown): {
  readonly ok: false;
  readonly status: 500;
  readonly body: unknown;
  readonly correlationId: string;
} {
  return { ok: false, status: 500, body, correlationId: "test" };
}
