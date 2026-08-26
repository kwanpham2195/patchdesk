export type AppDestination =
  | { readonly kind: "dashboard" }
  | {
      readonly kind: "workbench";
      readonly reviewId: string;
    };

export const primaryDestinations = [
  { kind: "dashboard", label: "Inbox" },
] as const;

export function destinationKey(destination: AppDestination): string {
  return destination.kind === "workbench"
    ? `workbench:${destination.reviewId}`
    : destination.kind;
}

export function destinationTitle(destination: AppDestination): string {
  switch (destination.kind) {
    case "dashboard":
      return "Maintainer inbox";
    case "workbench":
      return "Review workbench";
  }
}

export function parseDestination(value: string | null): AppDestination {
  if (value?.startsWith("workbench:")) {
    const [reviewId] = value.slice("workbench:".length).trim().split(":", 2);
    if (reviewId !== undefined && reviewId.length > 0)
      return { kind: "workbench", reviewId };
  }
  return { kind: "dashboard" };
}
