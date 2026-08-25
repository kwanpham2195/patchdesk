/**
 * Renderer screen-position persistence: after a reload the app should land
 * back on the exact screen the user was on. Workbench position uses
 * localStorage (consistent with the destination restore: survives relaunch);
 * the Settings overlay uses sessionStorage so a fresh launch never pops it
 * open. Values are validated on load and corrupt data is ignored.
 */

import * as v from "valibot";

const WORKBENCH_UI_KEY_PREFIX = "patchdesk.workbench-ui.v1.";
const SETTINGS_RESTORE_KEY = "patchdesk.settings.v1";

export type WorkbenchUiState = {
  activeTab?: "conversation" | "diff" | "insights";
  section?: "files" | "commits" | "insights" | "threads";
  selectedPath?: string;
};

export type SettingsRestoreState = {
  readonly section: string;
};

export function workbenchUiKey(reviewId: string): string {
  return `${WORKBENCH_UI_KEY_PREFIX}${reviewId}`;
}

/** Load the persisted UI position for one review; undefined when absent or invalid. */
export function loadWorkbenchUiState(
  reviewId: string,
): WorkbenchUiState | undefined {
  if (globalThis.window === undefined) return undefined;
  const raw = window.localStorage.getItem(workbenchUiKey(reviewId));
  if (raw === null) return undefined;
  return parseWorkbenchUiState(raw);
}

/** Persist the current UI position for one review. */
export function saveWorkbenchUiState(
  reviewId: string,
  state: WorkbenchUiState,
): void {
  if (globalThis.window === undefined) return;
  const normalized: WorkbenchUiState = {};
  if (state.activeTab !== undefined) normalized.activeTab = state.activeTab;
  if (state.section !== undefined) normalized.section = state.section;
  if (state.selectedPath !== undefined)
    normalized.selectedPath = state.selectedPath.slice(0, 2_000);
  window.localStorage.setItem(
    workbenchUiKey(reviewId),
    JSON.stringify(normalized),
  );
}

/** Remove the persisted position for one review (e.g., review removed from the workspace). */
export function clearWorkbenchUiState(reviewId: string): void {
  if (globalThis.window === undefined) return;
  window.localStorage.removeItem(workbenchUiKey(reviewId));
}

/** Load the Settings overlay restore; undefined when absent or invalid. */
export function loadSettingsRestore(): SettingsRestoreState | undefined {
  if (globalThis.window === undefined) return undefined;
  const raw = window.sessionStorage.getItem(SETTINGS_RESTORE_KEY);
  if (raw === null) return undefined;
  return parseSettingsRestore(raw);
}

/** Persist the open Settings section so a reload reopens the same section. */
export function saveSettingsRestore(section: string): void {
  if (globalThis.window === undefined) return;
  window.sessionStorage.setItem(
    SETTINGS_RESTORE_KEY,
    JSON.stringify({ section: section.slice(0, 48) }),
  );
}

/** Called when Settings closes normally: a later reload must not reopen it. */
export function clearSettingsRestore(): void {
  if (globalThis.window === undefined) return;
  window.sessionStorage.removeItem(SETTINGS_RESTORE_KEY);
}

const activeTabSchema = v.picklist(["conversation", "diff", "insights"]);
const sectionNameSchema = v.picklist([
  "files",
  "commits",
  "insights",
  "threads",
]);
const selectedPathSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.transform((value) => value.slice(0, 2_000)),
);

// Each field falls back independently to `undefined` (i.e. is simply
// omitted), matching the old hand-rolled checks: one wrong-typed or
// unrecognized field drops only itself, never the other sound fields.
const workbenchUiStateSchema = v.object({
  activeTab: v.fallback(v.optional(activeTabSchema), undefined),
  section: v.fallback(v.optional(sectionNameSchema), undefined),
  selectedPath: v.fallback(v.optional(selectedPathSchema), undefined),
});

function parseWorkbenchUiState(raw: string): WorkbenchUiState | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    const decoded = v.safeParse(workbenchUiStateSchema, parsed);
    if (!decoded.success) return undefined;
    const { activeTab, section, selectedPath } = decoded.output;
    const result: WorkbenchUiState = {};
    if (activeTab !== undefined) result.activeTab = activeTab;
    if (section !== undefined) result.section = section;
    if (selectedPath !== undefined) result.selectedPath = selectedPath;
    return Object.keys(result).length === 0 ? undefined : result;
  } catch {
    return undefined;
  }
}

const settingsSectionSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.transform((value) => value.slice(0, 48)),
);

const settingsRestoreSchema = v.object({
  section: settingsSectionSchema,
});

function parseSettingsRestore(raw: string): SettingsRestoreState | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    const decoded = v.safeParse(settingsRestoreSchema, parsed);
    return decoded.success ? { section: decoded.output.section } : undefined;
  } catch {
    return undefined;
  }
}
