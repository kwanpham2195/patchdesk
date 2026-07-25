export type AppDestination =
  | { readonly kind: "dashboard" }
  | { readonly kind: "workbench"; readonly sessionId: string; readonly initialSection?: "overview" | "diff" | "checks" }
  | { readonly kind: "settings" };

export const primaryDestinations = [
  { kind: "dashboard", label: "Inbox" },
  { kind: "settings", label: "Settings" },
] as const;

export function destinationKey(destination: AppDestination): string {
  return destination.kind === "workbench"
    ? `workbench:${destination.sessionId}:${destination.initialSection ?? "overview"}`
    : destination.kind;
}

export function destinationTitle(destination: AppDestination): string {
  switch (destination.kind) {
    case "dashboard":
      return "Maintainer inbox";
    case "workbench":
      return "Review workbench";
    case "settings":
      return "Settings";
  }
}

export function parseDestination(value: string | null): AppDestination {
  if (value?.startsWith("workbench:")) {
    const [sessionId, section] = value.slice("workbench:".length).trim().split(":", 2);
    if (sessionId !== undefined && sessionId.length > 0) return { kind: "workbench", sessionId, ...(section === "diff" || section === "checks" ? { initialSection: section } : {}) };
  }
  if (value === "settings") {
    return { kind: value };
  }
  return { kind: "dashboard" };
}
