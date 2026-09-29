// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useWorkspaceProfileEditor } from "../../src/renderer/src/flows/settings-workspace-profile-editor";
import type {
  Dashboard,
  Profile,
} from "../../src/renderer/src/renderer-models";
import type { DesktopResponse } from "../../src/main/ipc-contract";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

const profile: Profile = {
  id: "acme",
  label: "ACME",
  githubHost: "github.com",
  ghAccount: "patchdesk",
  rulePaths: ["/workspace/acme/AGENTS.md"],
};

const dashboard: Dashboard = { profile, dashboard: { repos: [] } };

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  desktop?.restore();
  desktop = undefined;
});

describe("useWorkspaceProfileEditor", () => {
  it("sends the whole profile with the committed field merged in", async () => {
    const desktopApi = installDesktopApi();
    const { result } = renderEditor();

    act(() => result.current.editScalar("label", "  Renamed  "));
    act(() => result.current.commitScalar("label"));

    await waitFor(() =>
      expect(desktopApi.request).toHaveBeenCalledWith({
        path: "/v1/profiles",
        method: "PUT",
        body: {
          id: "acme",
          label: "Renamed",
          githubHost: "github.com",
          ghAccount: "patchdesk",
          rulePaths: ["/workspace/acme/AGENTS.md"],
        },
      }),
    );
    await waitFor(() => expect(result.current.persisted.label).toBe("Renamed"));
  });

  it("composes two overlapping patches and lets only the latest response win", async () => {
    const releases: Array<() => void> = [];
    const desktopApi = installDesktopApi({
      profileSave: () =>
        new Promise<DesktopResponse>((resolve) => {
          releases.push(() => resolve(success({})));
        }),
    });
    const { result } = renderEditor();

    act(() => result.current.editScalar("label", "Renamed"));
    act(() => result.current.commitScalar("label"));
    act(() => result.current.editScalar("ghAccount", "other-user"));
    act(() => result.current.commitScalar("ghAccount"));
    await waitFor(() => expect(releases).toHaveLength(2));

    expect(profileSaveBodies(desktopApi)).toEqual([
      expect.objectContaining({ label: "Renamed", ghAccount: "patchdesk" }),
      expect.objectContaining({ label: "Renamed", ghAccount: "other-user" }),
    ]);

    // The first save answers last: its older body must not become the
    // persisted profile, or the second edit would be silently undone.
    const [first, second] = releases;
    act(() => second?.());
    await waitFor(() =>
      expect(result.current.persisted.ghAccount).toBe("other-user"),
    );
    await act(async () => {
      first?.();
      await Promise.resolve();
    });
    expect(result.current.persisted.ghAccount).toBe("other-user");
    expect(result.current.persisted.label).toBe("Renamed");
  });

  it("keeps the newest body as the merge base when an older save answers last", async () => {
    const releases: Array<() => void> = [];
    const desktopApi = installDesktopApi({
      profileSave: () =>
        new Promise<DesktopResponse>((resolve) => {
          releases.push(() => resolve(success({})));
        }),
    });
    const { result } = renderEditor();

    act(() => result.current.editScalar("label", "Renamed"));
    act(() => result.current.commitScalar("label"));
    act(() => result.current.editScalar("ghAccount", "other-user"));
    act(() => result.current.commitScalar("ghAccount"));
    await waitFor(() => expect(releases).toHaveLength(2));

    // The older save answers last, so its body is the last one this hook
    // sees — it must not become the base the next patch merges into.
    const [first, second] = releases;
    act(() => second?.());
    await waitFor(() =>
      expect(result.current.persisted.ghAccount).toBe("other-user"),
    );
    await act(async () => {
      first?.();
      await Promise.resolve();
    });

    act(() => result.current.editScalar("label", "Renamed again"));
    act(() => result.current.commitScalar("label"));
    await waitFor(() => expect(profileSaveBodies(desktopApi)).toHaveLength(3));
    expect(profileSaveBodies(desktopApi)[2]).toEqual(
      expect.objectContaining({
        label: "Renamed again",
        ghAccount: "other-user",
      }),
    );
  });

  it("leaves a field that is still saving alone when an older save for it answers", async () => {
    const releases: Array<() => void> = [];
    installDesktopApi({
      profileSave: () =>
        new Promise<DesktopResponse>((resolve) => {
          releases.push(() => resolve(success({})));
        }),
    });
    const { result } = renderEditor();

    act(() => result.current.editScalar("label", "First"));
    act(() => result.current.commitScalar("label"));
    act(() => result.current.editScalar("label", "Second"));
    act(() => result.current.commitScalar("label"));
    await waitFor(() => expect(releases).toHaveLength(2));

    // The first save for this field answers while the second is still in
    // flight: the field is still saving, so it must not claim to be saved.
    await act(async () => {
      releases[0]?.();
      await Promise.resolve();
    });
    expect(result.current.status.label.state).toBe("saving");
  });

  it("lets a profile switch win over a save still in flight for the profile it leaves", async () => {
    let release: (() => void) | undefined;
    installDesktopApi({
      profileSave: () =>
        new Promise<DesktopResponse>((resolve) => {
          release = () => resolve(success({}));
        }),
    });
    const other: Profile = {
      id: "other",
      label: "Other",
      githubHost: "github.com",
      ghAccount: "patchdesk",
      rulePaths: [],
    };
    const { result } = renderHook(() =>
      useWorkspaceProfileEditor({
        dashboard,
        unsavedProfile: undefined,
        profiles: [profile, other],
        onWorkspaceReload: async () => undefined,
        onProfileSwitch: async () => "applied",
      }),
    );

    act(() => result.current.editScalar("label", "Renamed"));
    act(() => result.current.commitScalar("label"));
    await waitFor(() =>
      expect(result.current.status.label.state).toBe("saving"),
    );
    act(() => result.current.selectProfile("other"));
    await waitFor(() => expect(result.current.persisted.id).toBe("other"));

    // The save for the profile just left answers now: its body belongs to
    // that profile, so it must not land on the one now loaded.
    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    expect(result.current.persisted.label).toBe("Other");
    expect(result.current.persisted.rulePaths).toEqual([]);
    expect(result.current.scalars.label).toBe("Other");
  });

  it("keeps the persisted value and reports a failed status when the save is rejected", async () => {
    installDesktopApi({ profileSave: () => failure({ error: "storage" }) });
    const { result } = renderEditor();

    act(() => result.current.editScalar("label", "Renamed"));
    act(() => result.current.commitScalar("label"));

    await waitFor(() =>
      expect(result.current.status.label.state).toBe("failed"),
    );
    expect(result.current.persisted.label).toBe("ACME");
    // The typed value stays on screen so the edit can be retried.
    expect(result.current.scalars.label).toBe("Renamed");
  });

  it("never sends a blank list row", async () => {
    const desktopApi = installDesktopApi();
    const { result } = renderEditor();

    act(() => result.current.addListEntry("rulePaths"));
    act(() => result.current.commitList("rulePaths"));
    const added = result.current.rows.rulePaths[1];
    if (added === undefined)
      throw new Error("Expected an added rule path row.");
    act(() =>
      result.current.editListEntry(
        "rulePaths",
        added.id,
        "/workspace/acme/CONTRIBUTING.md",
      ),
    );
    act(() => result.current.commitList("rulePaths"));

    await waitFor(() => expect(profileSaveBodies(desktopApi)).toHaveLength(1));
    expect(profileSaveBodies(desktopApi)[0]).toEqual(
      expect.objectContaining({
        rulePaths: [
          "/workspace/acme/AGENTS.md",
          "/workspace/acme/CONTRIBUTING.md",
        ],
      }),
    );
  });

  it("sends nothing when a commit carries the value already persisted", async () => {
    const desktopApi = installDesktopApi();
    const { result } = renderEditor();

    act(() => result.current.editScalar("label", "  ACME  "));
    act(() => result.current.commitScalar("label"));
    act(() => result.current.commitList("rulePaths"));

    expect(profileSaveBodies(desktopApi)).toHaveLength(0);
    // The commit still normalises what the input shows.
    expect(result.current.scalars.label).toBe("ACME");
  });

  it("saves the first account onto the unsaved default workspace with a PUT, and never creates or selects one", async () => {
    const desktopApi = installDesktopApi();
    const { result } = renderUnpersistedEditor();

    act(() => result.current.editScalar("ghAccount", "patchdesk"));
    act(() => result.current.commitScalar("ghAccount"));

    await waitFor(() =>
      expect(result.current.status.ghAccount.state).toBe("saved"),
    );
    expect(profileCalls(desktopApi)).toEqual([
      [
        "/v1/profiles",
        "PUT",
        {
          id: "default",
          label: "Default",
          githubHost: "github.com",
          ghAccount: "patchdesk",
          rulePaths: [],
        },
      ],
    ]);
    expect(result.current.persisted.ghAccount).toBe("patchdesk");
  });

  it("reports a save made before any workspace has loaded, and sends nothing", async () => {
    const desktopApi = installDesktopApi();
    const { result } = renderHook(() =>
      useWorkspaceProfileEditor({
        dashboard: undefined,
        unsavedProfile: undefined,
        profiles: [],
        onWorkspaceReload: async () => undefined,
        onProfileSwitch: undefined,
      }),
    );

    act(() => result.current.editScalar("label", "Personal"));
    act(() => result.current.commitScalar("label"));

    expect(result.current.status.label).toEqual({
      state: "failed",
      message: "Workspace still loading.",
    });
    expect(profileCalls(desktopApi)).toEqual([]);
  });

  it("refuses a rule path that is not an absolute path without sending it", async () => {
    const desktopApi = installDesktopApi();
    const { result } = renderEditor();

    const [row] = result.current.rows.rulePaths;
    if (row === undefined) throw new Error("Expected a rule path row.");
    act(() => result.current.editListEntry("rulePaths", row.id, "relative"));
    act(() => result.current.commitList("rulePaths"));

    expect(result.current.status.rulePaths.state).toBe("failed");
    expect(profileSaveBodies(desktopApi)).toHaveLength(0);
    expect(result.current.persisted.rulePaths).toEqual([
      "/workspace/acme/AGENTS.md",
    ]);
  });
});

/**
 * The profile `DashboardController.listProfiles` holds in memory when nothing
 * has ever been saved: `default`, with no account. No workspace loads for it,
 * since the inbox parser refuses the empty account, so the editor receives it
 * on its own.
 */
const unpersistedProfile: Profile = {
  id: "default",
  label: "Default",
  githubHost: "github.com",
  ghAccount: "",
  rulePaths: [],
};

function renderEditor() {
  return renderHook(() =>
    useWorkspaceProfileEditor({
      dashboard,
      unsavedProfile: undefined,
      profiles: [profile],
      onWorkspaceReload: async () => undefined,
      onProfileSwitch: undefined,
    }),
  );
}

function renderUnpersistedEditor() {
  return renderHook(() =>
    useWorkspaceProfileEditor({
      dashboard: undefined,
      unsavedProfile: unpersistedProfile,
      profiles: [],
      onWorkspaceReload: async () => undefined,
      onProfileSwitch: undefined,
    }),
  );
}

/** Every `/v1/profiles` call the editor made, as `[method, body]` pairs. */
function profileCalls(desktopApi: DesktopDouble) {
  return desktopApi.request.mock.calls
    .map(([input]) => input)
    .filter((input) => "path" in input && input.path.startsWith("/v1/profiles"))
    .map((input) =>
      "path" in input
        ? [input.path, input.method ?? "GET", input.body]
        : undefined,
    );
}

function profileSaveBodies(desktopApi: DesktopDouble) {
  return desktopApi.request.mock.calls
    .map(([input]) => input)
    .filter(
      (input) =>
        "path" in input &&
        input.path === "/v1/profiles" &&
        input.method === "PUT",
    )
    .map((input) => ("body" in input ? input.body : undefined));
}

function installDesktopApi(
  options: {
    readonly profileSave?: () => DesktopResponse | Promise<DesktopResponse>;
  } = {},
): DesktopDouble {
  desktop = installDesktopDouble({
    "/v1/profiles": () =>
      options.profileSave === undefined ? success({}) : options.profileSave(),
  });
  return desktop;
}
