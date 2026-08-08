/**
 * Renderer screen-position persistence: after a reload the app should land
 * back on the exact screen the user was on. Workbench position uses
 * localStorage (consistent with the destination restore: survives relaunch);
 * the Settings overlay uses sessionStorage so a fresh launch never pops it
 * open. Values are validated on load and corrupt data is ignored.
 */

const WORKBENCH_UI_KEY_PREFIX = "patchdesk.workbench-ui.v1.";
const SETTINGS_RESTORE_KEY = "patchdesk.settings.v1";

export type WorkbenchUiState = {
  activeTab?: "conversation" | "diff" | "insights";
  section?: "files" | "findings" | "commits" | "insights";
  selectedPath?: string;
};

export type SettingsRestoreState = {
  readonly section: string;
};

export function workbenchUiKey(reviewId: string): string {
  return `${WORKBENCH_UI_KEY_PREFIX}${reviewId}`;
}

/** Load the persisted UI position for one review; undefined when absent or invalid. */
export function loadWorkbenchUiState(reviewId: string): WorkbenchUiState | undefined {
  if (typeof window === "undefined") return undefined;
  const raw = window.localStorage.getItem(workbenchUiKey(reviewId));
  if (raw === null) return undefined;
  return parseWorkbenchUiState(raw);
}

/** Persist the current UI position for one review. */
export function saveWorkbenchUiState(reviewId: string, state: WorkbenchUiState): void {
  if (typeof window === "undefined") return;
  const normalized: WorkbenchUiState = {};
  if (state.activeTab !== undefined) normalized.activeTab = state.activeTab;
  if (state.section !== undefined) normalized.section = state.section;
  if (state.selectedPath !== undefined) normalized.selectedPath = state.selectedPath.slice(0, 2_000);
  window.localStorage.setItem(workbenchUiKey(reviewId), JSON.stringify(normalized));
}

/** Remove the persisted position for one review (e.g., review removed from the workspace). */
export function clearWorkbenchUiState(reviewId: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(workbenchUiKey(reviewId));
}

/** Load the Settings overlay restore; undefined when absent or invalid. */
export function loadSettingsRestore(): SettingsRestoreState | undefined {
  if (typeof window === "undefined") return undefined;
  const raw = window.sessionStorage.getItem(SETTINGS_RESTORE_KEY);
  if (raw === null) return undefined;
  return parseSettingsRestore(raw);
}

/** Persist the open Settings section so a reload reopens the same section. */
export function saveSettingsRestore(section: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(SETTINGS_RESTORE_KEY, JSON.stringify({ section: section.slice(0, 48) }));
}

/** Called when Settings closes normally: a later reload must not reopen it. */
export function clearSettingsRestore(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(SETTINGS_RESTORE_KEY);
}

function parseWorkbenchUiState(raw: string): WorkbenchUiState | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    const result: WorkbenchUiState = {};
    if (record.activeTab === "conversation" || record.activeTab === "diff" || record.activeTab === "insights") {
      result.activeTab = record.activeTab;
    }
    if (record.section === "files" || record.section === "findings" || record.section === "commits" || record.section === "insights") {
      result.section = record.section;
    }
    if (typeof record.selectedPath === "string" && record.selectedPath.length > 0) {
      result.selectedPath = record.selectedPath.slice(0, 2_000);
    }
    return Object.keys(result).length === 0 ? undefined : result;
  } catch {
    return undefined;
  }
}

function parseSettingsRestore(raw: string): SettingsRestoreState | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const section = (parsed as Record<string, unknown>).section;
    if (typeof section !== "string" || section.length === 0) return undefined;
    return { section: section.slice(0, 48) };
  } catch {
    return undefined;
  }
}
