// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  clearSettingsRestore,
  clearWorkbenchUiState,
  loadSettingsRestore,
  loadWorkbenchUiState,
  saveSettingsRestore,
  saveWorkbenchUiState,
} from "../../src/renderer/src/lib/screen-restore";

// The storage key is written out here rather than imported from the module
// under test, so the test pins the persisted key format instead of
// restating whatever the implementation happens to build.
const workbenchUiKey = (reviewId: string): string =>
  `patchdesk.workbench-ui.v1.${reviewId}`;

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

  it.each([
    ["invalid JSON", "not-json"],
    ["unknown tab", '{"activeTab":"pants"}'],
    ["invalid section", '{"section":"findings"}'],
    ["wrong-typed path", '{"selectedPath":42}'],
  ])("ignores %s", (_case, raw) => {
    window.localStorage.setItem(workbenchUiKey(reviewIdA), raw);
    expect(loadWorkbenchUiState(reviewIdA)).toBeUndefined();
  });

  it("keeps a valid section when other position fields are absent", () => {
    window.localStorage.setItem(
      workbenchUiKey(reviewIdA),
      JSON.stringify({ section: "commits" }),
    );
    expect(loadWorkbenchUiState(reviewIdA)).toEqual({ section: "commits" });
  });

  // Degradation pins (written before the valibot conversion, run against the
  // unconverted code first): a malformed persisted value must degrade to
  // `undefined`/a partial object exactly as it does today, never throw, and
  // never silently drop a field that today survives.
  it.each([
    ["number", JSON.stringify(42)],
    ["string", JSON.stringify("diff")],
    ["null", JSON.stringify(null)],
    ["array", JSON.stringify(["diff", "files"])],
  ])("returns undefined for a persisted %s", (_type, raw) => {
    window.localStorage.setItem(workbenchUiKey(reviewIdA), raw);
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

  it("drops a removed tab value from an older build and keeps the rest", () => {
    window.localStorage.setItem(
      workbenchUiKey(reviewIdA),
      JSON.stringify({
        activeTab: "call_flow",
        section: "files",
        selectedPath: "src/a.ts",
      }),
    );
    expect(loadWorkbenchUiState(reviewIdA)).toEqual({
      section: "files",
      selectedPath: "src/a.ts",
    });
  });

  it("clamps an over-long selectedPath while loading persisted data", () => {
    const longPath = "a".repeat(2_500);
    window.localStorage.setItem(
      workbenchUiKey(reviewIdA),
      JSON.stringify({ selectedPath: longPath }),
    );
    expect(loadWorkbenchUiState(reviewIdA)).toEqual({
      selectedPath: "a".repeat(2_000),
    });
  });

  it("clamps an over-long selectedPath before saving it", () => {
    saveWorkbenchUiState(reviewIdA, { selectedPath: "a".repeat(2_500) });

    expect(window.localStorage.getItem(workbenchUiKey(reviewIdA))).toBe(
      JSON.stringify({ selectedPath: "a".repeat(2_000) }),
    );
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

  it.each([
    ["invalid JSON", "garbage"],
    ["empty section", JSON.stringify({ section: "" })],
  ])("ignores %s", (_case, raw) => {
    window.sessionStorage.setItem("patchdesk.settings.v1", raw);
    expect(loadSettingsRestore()).toBeUndefined();
  });

  // Degradation pins (written before the valibot conversion, run against the
  // unconverted code first).
  it.each([
    ["number", JSON.stringify(42)],
    ["null", JSON.stringify(null)],
    ["array", JSON.stringify(["logs"])],
  ])("returns undefined for a persisted %s", (_type, raw) => {
    window.sessionStorage.setItem("patchdesk.settings.v1", raw);
    expect(loadSettingsRestore()).toBeUndefined();
  });

  it.each([
    ["missing", JSON.stringify({})],
    ["wrong-typed", JSON.stringify({ section: 42 })],
  ])("returns undefined when the section field is %s", (_case, raw) => {
    window.sessionStorage.setItem("patchdesk.settings.v1", raw);
    expect(loadSettingsRestore()).toBeUndefined();
  });

  it("clamps an over-long section while loading persisted data", () => {
    const longSection = "s".repeat(60);
    window.sessionStorage.setItem(
      "patchdesk.settings.v1",
      JSON.stringify({ section: longSection }),
    );
    expect(loadSettingsRestore()).toEqual({ section: "s".repeat(48) });
  });

  it("clamps an over-long section before saving it", () => {
    saveSettingsRestore("s".repeat(60));

    expect(window.sessionStorage.getItem("patchdesk.settings.v1")).toBe(
      JSON.stringify({ section: "s".repeat(48) }),
    );
  });
});
