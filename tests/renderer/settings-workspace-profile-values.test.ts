import { describe, expect, it } from "vitest";

import {
  profileValuesFor,
  rowsFor,
} from "../../src/renderer/src/flows/settings-workspace-profile-values";

describe("rowsFor", () => {
  it("gives a workspace with no folder one blank folder row", () => {
    const rows = rowsFor(
      profileValuesFor({
        id: "default",
        label: "Default",
        githubHost: "github.com",
        ghAccount: "patchdesk",
        workspaceRoots: [],
        rulePaths: [],
      }),
    );

    // Without this row the card's only affordance is "Add folder": "Choose
    // folder" and the first-root prompt both belong to a row.
    expect(rows.workspaceRoots).toHaveLength(1);
    expect(rows.workspaceRoots[0]?.value).toBe("");
    // Rule paths are optional configuration and get no such row.
    expect(rows.rulePaths).toEqual([]);
  });

  it("gives one row per persisted folder", () => {
    const rows = rowsFor(
      profileValuesFor({
        id: "cfw",
        label: "CFW",
        githubHost: "github.com",
        ghAccount: "patchdesk",
        workspaceRoots: ["/workspace/cfw", "/workspace/other"],
        rulePaths: ["/workspace/cfw/AGENTS.md"],
      }),
    );

    expect(rows.workspaceRoots.map((entry) => entry.value)).toEqual([
      "/workspace/cfw",
      "/workspace/other",
    ]);
    expect(rows.rulePaths.map((entry) => entry.value)).toEqual([
      "/workspace/cfw/AGENTS.md",
    ]);
  });
});
