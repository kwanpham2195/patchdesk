// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreateWorkspaceDialog } from "../../src/renderer/src/flows/settings-workspace-create-dialog";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  desktop?.restore();
  desktop = undefined;
});

describe("New workspace dialog", () => {
  it("posts a workspace without an id, then selects the id the service derived", async () => {
    const desktopApi = installDesktopApi();
    const user = userEvent.setup();
    const onCreated = vi.fn(async () => undefined);
    const onOpenChange = vi.fn();

    renderDialog({ onCreated, onOpenChange });

    expect(
      await screen.findByRole("combobox", { name: "Account" }),
    ).toBeTruthy();
    await user.type(screen.getByLabelText("Name"), "Central Digital");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));

    await vi.waitFor(() =>
      expect(desktopApi.request).toHaveBeenCalledWith({
        path: "/v1/profiles",
        method: "POST",
        body: {
          label: "Central Digital",
          githubHost: "github.com",
          ghAccount: "patchdesk",
          workspaceRoots: [],
          rulePaths: [],
        },
      }),
    );
    expect(desktopApi.request).toHaveBeenCalledWith({
      path: "/v1/profiles/select",
      method: "POST",
      body: { id: "central-digital" },
    });
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("asks for the account manually when no authenticated account is reported", async () => {
    const desktopApi = installDesktopApi({
      environment: {
        git: "ready",
        gh: "ready",
        githubAuth: "authentication_required",
        githubAccounts: [],
      },
    });
    const user = userEvent.setup();

    renderDialog();

    expect(
      await screen.findByLabelText<HTMLInputElement>("GitHub host"),
    ).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("GitHub host").value).toBe(
      "github.com",
    );
    await user.type(screen.getByLabelText("Name"), "Enterprise");
    await user.type(screen.getByLabelText("GitHub account"), "enterprise-user");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));

    await vi.waitFor(() =>
      expect(desktopApi.request).toHaveBeenCalledWith({
        path: "/v1/profiles",
        method: "POST",
        body: {
          label: "Enterprise",
          githubHost: "github.com",
          ghAccount: "enterprise-user",
          workspaceRoots: [],
          rulePaths: [],
        },
      }),
    );
  });

  it("says it is still checking instead of offering the manual fields", async () => {
    installDesktopApi({ environment: "never" });

    renderDialog();

    expect(screen.getByText("Checking GitHub authentication…")).toBeTruthy();
    expect(screen.queryByLabelText("GitHub account")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Account" })).toBeNull();
    // SAFETY: "Create workspace" is rendered by `<Button>`
    // (src/renderer/src/components/ui/button.tsx), which wraps base-ui's
    // `Button` with `nativeButton` left at its default `true`.
    expect(
      (
        screen.getByRole("button", {
          name: "Create workspace",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("reports a blank name beside the field without posting", async () => {
    const desktopApi = installDesktopApi();
    const user = userEvent.setup();

    renderDialog();
    await user.click(screen.getByRole("button", { name: "Create workspace" }));

    const name = screen.getByLabelText("Name");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe(
      "create-workspace-name-error",
    );
    expect(
      document.getElementById("create-workspace-name-error")?.textContent,
    ).toBe("Name cannot be blank.");
    expect(profileCreateRequests(desktopApi)).toHaveLength(0);
  });

  it("keeps the dialog open and shows the failure when the create is rejected", async () => {
    installDesktopApi({ rejectProfileSave: true });
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    renderDialog({ onOpenChange });
    await user.type(screen.getByLabelText("Name"), "Central Digital");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));

    expect(await screen.findByText("Workspace not created")).toBeTruthy();
    expect(screen.getByTestId("create-workspace-dialog")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("closes without any request when the create is cancelled", async () => {
    const desktopApi = installDesktopApi();
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    renderDialog({ onOpenChange });
    await user.type(screen.getByLabelText("Name"), "Central Digital");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(profileCreateRequests(desktopApi)).toHaveLength(0);
  });
});

function profileCreateRequests(desktopApi: DesktopDouble) {
  return desktopApi.request.mock.calls
    .map(([input]) => input)
    .filter((input) => "path" in input && input.path === "/v1/profiles");
}

function renderDialog(
  options: {
    readonly onCreated?: () => Promise<void>;
    readonly onOpenChange?: (open: boolean) => void;
  } = {},
): void {
  render(
    <CreateWorkspaceDialog
      open
      onOpenChange={options.onOpenChange ?? (() => undefined)}
      onCreated={options.onCreated ?? (async () => undefined)}
    />,
  );
}

function installDesktopApi(
  options: {
    readonly rejectProfileSave?: boolean;
    /** "never" leaves the probe unanswered, which is the checking state. */
    readonly environment?: Parameters<typeof success>[0] | "never";
  } = {},
): DesktopDouble {
  desktop = installDesktopDouble({
    "/v1/environment": () =>
      options.environment === "never"
        ? new Promise<never>(() => undefined)
        : success(
            options.environment ?? {
              git: "ready",
              gh: "ready",
              githubAuth: "ready",
              githubAccounts: [
                { host: "github.com", login: "patchdesk", active: true },
              ],
            },
          ),
    "/v1/profiles": () =>
      options.rejectProfileSave === true
        ? failure({ error: "storage" })
        : // The id the service derived from the name, which is the value the
          // dialog must select rather than one it invented.
          success({ id: "central-digital" }),
    "/v1/profiles/select": () => success({}),
  });
  return desktop;
}
