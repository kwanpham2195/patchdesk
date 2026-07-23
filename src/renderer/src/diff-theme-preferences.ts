export type DiffThemeFamily = "github" | "high_contrast";

export const DIFF_THEME_FAMILIES: ReadonlyArray<{ readonly id: DiffThemeFamily; readonly label: string; readonly light: string; readonly dark: string }> = [
  { id: "github", label: "GitHub", light: "github-light", dark: "github-dark" },
  { id: "high_contrast", label: "High contrast", light: "github-light", dark: "github-dark-high-contrast" },
];

const storageKey = "patchdesk.diff-theme.v1";

export function loadDiffThemeFamily(): DiffThemeFamily {
  if (typeof window === "undefined") return "github";
  return window.localStorage.getItem(storageKey) === "high_contrast" ? "high_contrast" : "github";
}

export function saveDiffThemeFamily(value: DiffThemeFamily): void {
  window.localStorage.setItem(storageKey, value);
  window.dispatchEvent(new CustomEvent<DiffThemeFamily>("patchdesk:diff-theme", { detail: value }));
}

export function diffThemeFor(value: DiffThemeFamily, appearance: "light" | "dark"): string {
  const family = DIFF_THEME_FAMILIES.find((candidate) => candidate.id === value) ?? DIFF_THEME_FAMILIES[0];
  return appearance === "dark" ? family?.dark ?? "github-dark" : family?.light ?? "github-light";
}
