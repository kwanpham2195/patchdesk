import * as v from "valibot";

import { definePreference } from "./lib/local-preference";

export type AppearancePreference = "system" | "light" | "dark";
export type ResolvedAppearance = "light" | "dark";

const DEFAULT_APPEARANCE: AppearancePreference = "system";

// The key holds the bare literal, not JSON, so the stored text goes to the
// schema unchanged. Nothing writes it any more: config.json is the durable
// store, and clearAppearancePreference() removes this value once config.json
// has accepted it.
const appearancePreference = definePreference({
  key: "patchdesk.appearance.v1",
  schema: v.picklist(["light", "dark"]),
  defaultValue: DEFAULT_APPEARANCE,
  decodeStored: (raw: string) => raw,
});

export function loadAppearancePreference(): AppearancePreference {
  return appearancePreference.load();
}

/** Removes the renderer preference after it has been persisted to config.json. */
export function clearAppearancePreference(): void {
  appearancePreference.clear();
}

function resolveAppearance(value: AppearancePreference): ResolvedAppearance {
  if (value !== "system") return value;
  return globalThis.window !== undefined &&
    window.matchMedia !== undefined &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Applies the class consumed by Base Nova and announces appearance changes to Pierre. */
export function applyAppearance(
  value: AppearancePreference,
): ResolvedAppearance {
  const resolved = resolveAppearance(value);
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.appearance = resolved;
  root.style.colorScheme = resolved;
  window.dispatchEvent(
    new CustomEvent<ResolvedAppearance>("patchdesk:appearance", {
      detail: resolved,
    }),
  );
  return resolved;
}
