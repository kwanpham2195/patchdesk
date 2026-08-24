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

  it("restores the Call Flow tab", () => {
    saveWorkbenchUiState(reviewIdA, {
      activeTab: "call_flow",
      section: "files",
    });
    expect(loadWorkbenchUiState(reviewIdA)).toEqual({
      activeTab: "call_flow",
      section: "files",
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

  // Degradation pins (written before the valibot conversion, run against the
  // unconverted code first): a malformed persisted value must degrade to
  // `undefined`/a partial object exactly as it does today, never throw, and
  // never silently drop a field that today survives.
  it("degrades a non-object persisted value to undefined", () => {
    window.localStorage.setItem(workbenchUiKey(reviewIdA), JSON.stringify(42));
    expect(loadWorkbenchUiState(reviewIdA)).toBeUndefined();

    window.localStorage.setItem(
      workbenchUiKey(reviewIdA),
      JSON.stringify("diff"),
    );
    expect(loadWorkbenchUiState(reviewIdA)).toBeUndefined();

    window.localStorage.setItem(
      workbenchUiKey(reviewIdA),
      JSON.stringify(null),
    );
    expect(loadWorkbenchUiState(reviewIdA)).toBeUndefined();

    window.localStorage.setItem(
      workbenchUiKey(reviewIdA),
      JSON.stringify(["diff", "files"]),
    );
    expect(loadWorkbenchUiState(reviewIdA)).toBeUndefined();
  });

  it("returns undefined with no persisted value at all", () => {
    expect(loadWorkbenchUiState("review-never-saved")).toBeUndefined();
  });

  it("drops only the wrong-typed field, keeping the sound ones", () => {
    window.localStorage.setItem(
      workbenchUiKey(reviewIdA),
      JSON.stringify({ activeTab: 42, section: "files" }),
    );
    expect(loadWorkbenchUiState(reviewIdA)).toEqual({ section: "files" });
  });

  it("clamps an over-long selectedPath the same way on load as on save", () => {
    const longPath = "a".repeat(2_500);
    window.localStorage.setItem(
      workbenchUiKey(reviewIdA),
      JSON.stringify({ selectedPath: longPath }),
    );
    expect(loadWorkbenchUiState(reviewIdA)).toEqual({
      selectedPath: "a".repeat(2_000),
    });
  });

  it("drops a zero-length selectedPath", () => {
    window.localStorage.setItem(
      workbenchUiKey(reviewIdA),
      JSON.stringify({ selectedPath: "" }),
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

  // Degradation pins (written before the valibot conversion, run against the
  // unconverted code first).
  it("degrades a non-object persisted value to undefined", () => {
    window.sessionStorage.setItem("patchdesk.settings.v1", JSON.stringify(42));
    expect(loadSettingsRestore()).toBeUndefined();

    window.sessionStorage.setItem(
      "patchdesk.settings.v1",
      JSON.stringify(null),
    );
    expect(loadSettingsRestore()).toBeUndefined();

    window.sessionStorage.setItem(
      "patchdesk.settings.v1",
      JSON.stringify(["logs"]),
    );
    expect(loadSettingsRestore()).toBeUndefined();
  });

  it("returns undefined when the section field is missing or wrong-typed", () => {
    window.sessionStorage.setItem("patchdesk.settings.v1", JSON.stringify({}));
    expect(loadSettingsRestore()).toBeUndefined();

    window.sessionStorage.setItem(
      "patchdesk.settings.v1",
      JSON.stringify({ section: 42 }),
    );
    expect(loadSettingsRestore()).toBeUndefined();
  });

  it("clamps an over-long section the same way on load as on save", () => {
    const longSection = "s".repeat(60);
    window.sessionStorage.setItem(
      "patchdesk.settings.v1",
      JSON.stringify({ section: longSection }),
    );
    expect(loadSettingsRestore()).toEqual({ section: "s".repeat(48) });
  });
});
