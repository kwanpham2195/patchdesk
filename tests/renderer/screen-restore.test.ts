// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  clearSettingsRestore,
  clearWorkbenchUiState,
  loadSettingsRestore,
  loadWorkbenchUiState,
  saveSettingsRestore,
  saveWorkbenchUiState,
  workbenchUiKey,
} from "../../src/renderer/src/lib/screen-restore";

const reviewIdA = "review-a";
const reviewIdB = "review-b";

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("workbench UI position persistence", () => {
  it("round-trips the persisted position", () => {
    saveWorkbenchUiState(reviewIdA, {
      activeTab: "diff",
      section: "files",
      selectedPath: "src/main.ts",
    });
    expect(loadWorkbenchUiState(reviewIdA)).toEqual({
      activeTab: "diff",
      section: "files",
      selectedPath: "src/main.ts",
    });
  });

  it("scopes positions per review", () => {
    saveWorkbenchUiState(reviewIdA, { activeTab: "diff", section: "files" });
    saveWorkbenchUiState(reviewIdB, {
      activeTab: "insights",
      section: "insights",
    });
    expect(loadWorkbenchUiState(reviewIdA)?.activeTab).toBe("diff");
    expect(loadWorkbenchUiState(reviewIdB)?.activeTab).toBe("insights");
    expect(loadWorkbenchUiState("review-c")).toBeUndefined();
  });

  it("clears a review position on demand", () => {
    saveWorkbenchUiState(reviewIdA, { activeTab: "diff" });
    clearWorkbenchUiState(reviewIdA);
    expect(loadWorkbenchUiState(reviewIdA)).toBeUndefined();
  });

  it("ignores corrupt or unknown values", () => {
    window.localStorage.setItem(workbenchUiKey(reviewIdA), "not-json");
    expect(loadWorkbenchUiState(reviewIdA)).toBeUndefined();
    window.localStorage.setItem(
      workbenchUiKey(reviewIdA),
      JSON.stringify({ activeTab: "pants" }),
    );
    expect(loadWorkbenchUiState(reviewIdA)).toBeUndefined();
    window.localStorage.setItem(
      workbenchUiKey(reviewIdA),
      JSON.stringify({ section: "commits" }),
    );
    expect(loadWorkbenchUiState(reviewIdA)).toEqual({ section: "commits" });
    window.localStorage.setItem(
      workbenchUiKey(reviewIdA),
      JSON.stringify({ section: "findings" }),
    );
    expect(loadWorkbenchUiState(reviewIdA)).toBeUndefined();
    window.localStorage.setItem(
      workbenchUiKey(reviewIdA),
      JSON.stringify({ selectedPath: 42 }),
    );
    expect(loadWorkbenchUiState(reviewIdA)).toBeUndefined();
  });
});

describe("settings overlay restore", () => {
  it("round-trips and clears the open section", () => {
    expect(loadSettingsRestore()).toBeUndefined();
    saveSettingsRestore("logs");
    expect(loadSettingsRestore()).toEqual({ section: "logs" });
    clearSettingsRestore();
    expect(loadSettingsRestore()).toBeUndefined();
  });

  it("ignores corrupt values", () => {
    window.sessionStorage.setItem("patchdesk.settings.v1", "garbage");
    expect(loadSettingsRestore()).toBeUndefined();
    window.sessionStorage.setItem(
      "patchdesk.settings.v1",
      JSON.stringify({ section: "" }),
    );
    expect(loadSettingsRestore()).toBeUndefined();
  });
});
