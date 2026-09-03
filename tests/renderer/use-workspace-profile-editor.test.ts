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
  id: "cfw",
  label: "CFW",
  githubHost: "github.com",
  ghAccount: "patchdesk",
  workspaceRoots: ["/workspace/cfw"],
  rulePaths: ["/workspace/cfw/AGENTS.md"],
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
          id: "cfw",
          label: "Renamed",
          githubHost: "github.com",
          ghAccount: "patchdesk",
          workspaceRoots: ["/workspace/cfw"],
          rulePaths: ["/workspace/cfw/AGENTS.md"],
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
      workspaceRoots: ["/workspace/other"],
      rulePaths: [],
    };
    const { result } = renderHook(() =>
      useWorkspaceProfileEditor({
        dashboard,
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
    expect(result.current.persisted.workspaceRoots).toEqual([
      "/workspace/other",
    ]);
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
    expect(result.current.persisted.label).toBe("CFW");
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
        "/workspace/cfw/CONTRIBUTING.md",
      ),
    );
    act(() => result.current.commitList("rulePaths"));

    await waitFor(() => expect(profileSaveBodies(desktopApi)).toHaveLength(1));
    expect(profileSaveBodies(desktopApi)[0]).toEqual(
      expect.objectContaining({
        rulePaths: [
          "/workspace/cfw/AGENTS.md",
          "/workspace/cfw/CONTRIBUTING.md",
        ],
      }),
    );
  });

  it("sends nothing when a commit carries the value already persisted", async () => {
    const desktopApi = installDesktopApi();
    const { result } = renderEditor();

    act(() => result.current.editScalar("label", "  CFW  "));
    act(() => result.current.commitScalar("label"));
    act(() => result.current.commitList("workspaceRoots"));

    expect(profileSaveBodies(desktopApi)).toHaveLength(0);
    // The commit still normalises what the input shows.
    expect(result.current.scalars.label).toBe("CFW");
  });

  it("creates the workspace on the first save of a profile that was never persisted", async () => {
    const desktopApi = installDesktopApi();
    const { result } = renderUnpersistedEditor();

    act(() => result.current.editScalar("ghAccount", "patchdesk"));
    act(() => result.current.commitScalar("ghAccount"));

    await waitFor(() =>
      expect(result.current.status.ghAccount.state).toBe("saved"),
    );
    // No id is sent: the service derives it from the label, which defaults to
    // "Default" because the ephemeral profile carries none.
    expect(profileCalls(desktopApi)).toEqual([
      [
        "/v1/profiles",
        "POST",
        {
          label: "Default",
          githubHost: "github.com",
          ghAccount: "patchdesk",
          workspaceRoots: [],
          rulePaths: [],
        },
      ],
      ["/v1/profiles/select", "POST", { id: "default" }],
    ]);
    expect(result.current.persisted.id).toBe("default");

    // The created id is adopted, so the next save updates rather than
    // creating a second workspace.
    act(() => result.current.editScalar("label", "Renamed"));
    act(() => result.current.commitScalar("label"));
    await waitFor(() => expect(profileSaveBodies(desktopApi)).toHaveLength(1));
    expect(profileSaveBodies(desktopApi)[0]).toEqual(
      expect.objectContaining({ id: "default", label: "Renamed" }),
    );
  });

  it("reports a failed status and keeps the profile when the creation answers without an id", async () => {
    const desktopApi = installDesktopApi({
      profileCreate: () => success({}),
    });
    const { result } = renderUnpersistedEditor();

    act(() => result.current.editScalar("ghAccount", "patchdesk"));
    act(() => result.current.commitScalar("ghAccount"));

    await waitFor(() =>
      expect(result.current.status.ghAccount.state).toBe("failed"),
    );
    // Nothing was selected: an unreadable creation leaves no workspace to
    // switch to, and the editor still holds the unpersisted profile.
    expect(profileCalls(desktopApi)).toEqual([
      ["/v1/profiles", "POST", expect.objectContaining({ label: "Default" })],
    ]);
    expect(result.current.persisted.id).toBe("");
    expect(result.current.persisted.ghAccount).toBe("");
    // The typed value stays on screen so the choice can be retried.
    expect(result.current.scalars.ghAccount).toBe("patchdesk");
  });

  it("refuses a workspace root that is not an absolute path without sending it", async () => {
    const desktopApi = installDesktopApi();
    const { result } = renderEditor();

    const [row] = result.current.rows.workspaceRoots;
    if (row === undefined) throw new Error("Expected a workspace root row.");
    act(() =>
      result.current.editListEntry("workspaceRoots", row.id, "relative"),
    );
    act(() => result.current.commitList("workspaceRoots"));

    expect(result.current.status.workspaceRoots.state).toBe("failed");
    expect(profileSaveBodies(desktopApi)).toHaveLength(0);
    expect(result.current.persisted.workspaceRoots).toEqual(["/workspace/cfw"]);
  });
});

/**
 * The ephemeral profile `DashboardController.listProfiles` hands back when
 * nothing has ever been saved: no id, no label, and no account. The domain
 * parser refuses all three, so the editor's first save has to create the
 * workspace rather than update one.
 */
const unpersistedProfile: Profile = {
  id: "",
  label: "",
  githubHost: "github.com",
  ghAccount: "",
  workspaceRoots: [],
  rulePaths: [],
};

/** A stable dashboard, so the editor's resync effect runs once — as it does
 * in the app, where the prop only changes when the server's profile does. */
const unpersistedDashboard: Dashboard = {
  profile: unpersistedProfile,
  dashboard: { repos: [] },
};

function renderEditor() {
  return renderHook(() =>
    useWorkspaceProfileEditor({
      dashboard,
      profiles: [profile],
      onWorkspaceReload: async () => undefined,
      onProfileSwitch: undefined,
    }),
  );
}

function renderUnpersistedEditor() {
  return renderHook(() =>
    useWorkspaceProfileEditor({
      dashboard: unpersistedDashboard,
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
    /** Answers `POST /v1/profiles`, the creation of a workspace that has none. */
    readonly profileCreate?: () => DesktopResponse | Promise<DesktopResponse>;
  } = {},
): DesktopDouble {
  desktop = installDesktopDouble({
    "/v1/profiles": (input) => {
      if (input.method === "POST")
        return options.profileCreate === undefined
          ? success({ id: "default" })
          : options.profileCreate();
      return options.profileSave === undefined
        ? success({})
        : options.profileSave();
    },
    "/v1/profiles/select": () => success({}),
  });
  return desktop;
}
