export type AppDestination =
  | { readonly kind: "dashboard" }
  | { readonly kind: "workbench"; readonly sessionId: string }
  | { readonly kind: "drafts" }
  | { readonly kind: "history" }
  | { readonly kind: "settings" };

export const primaryDestinations = [
  { kind: "dashboard", label: "Inbox" },
  { kind: "drafts", label: "Drafts" },
  { kind: "history", label: "History" },
  { kind: "settings", label: "Settings" },
] as const;

export function destinationKey(destination: AppDestination): string {
  return destination.kind === "workbench"
    ? `workbench:${destination.sessionId}`
    : destination.kind;
}

export function destinationTitle(destination: AppDestination): string {
  switch (destination.kind) {
    case "dashboard":
      return "Maintainer inbox";
    case "workbench":
      return "Review workbench";
    case "drafts":
      return "Review drafts";
    case "history":
      return "Review history";
    case "settings":
      return "Settings";
  }
}

export function parseDestination(value: string | null): AppDestination {
  if (value?.startsWith("workbench:")) {
    const sessionId = value.slice("workbench:".length).trim();
    if (sessionId.length > 0) return { kind: "workbench", sessionId };
  }
  if (value === "drafts" || value === "history" || value === "settings") {
    return { kind: value };
  }
  return { kind: "dashboard" };
}
