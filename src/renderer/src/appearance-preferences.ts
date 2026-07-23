export type AppearancePreference = "system" | "light" | "dark";
export type ResolvedAppearance = "light" | "dark";

const STORAGE_KEY = "patchdesk.appearance.v1";

export function loadAppearancePreference(): AppearancePreference {
  if (typeof window === "undefined") return "system";
  const value = window.localStorage.getItem(STORAGE_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

export function saveAppearancePreference(value: AppearancePreference): void {
  window.localStorage.setItem(STORAGE_KEY, value);
}

export function resolveAppearance(value: AppearancePreference): ResolvedAppearance {
  if (value !== "system") return value;
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Applies the class consumed by Base Nova and announces appearance changes to Pierre. */
export function applyAppearance(value: AppearancePreference): ResolvedAppearance {
  const resolved = resolveAppearance(value);
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.appearance = resolved;
  root.style.colorScheme = resolved;
  window.dispatchEvent(new CustomEvent<ResolvedAppearance>("patchdesk:appearance", { detail: resolved }));
  return resolved;
}
