export type DesktopNavigationState = "clear" | "dirty_draft" | "write_pending";

/** Resolves whether a user-initiated desktop close may continue without losing owned state. */
export async function resolveDesktopClose(
  state: DesktopNavigationState,
  confirmDiscard: () => Promise<boolean>,
): Promise<"allow" | "prevent"> {
  if (state === "clear") return "allow";
  if (state === "write_pending") return "prevent";
  return await confirmDiscard() ? "allow" : "prevent";
}
