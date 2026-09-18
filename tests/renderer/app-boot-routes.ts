import { success, type DesktopRoute } from "./fake-desktop-response";

/**
 * The paths `App` requests on every boot that no test asserts on, plus the
 * navigation-state and destination operations it reports after each change.
 * Naming them keeps the double strict about the ones a test is about.
 */
export const APP_BOOT_ROUTES = {
  "/v1/logs": () => success(null),
  "/v1/settings": () => success({}),
  "/v1/environment": () => success({}),
  "/v1/watchlist/suggestions": () => success([]),
  "/v1/sidebar/reviews": () => success({ rows: [], unreadable: 0 }),
  "/v1/watched-pull-requests": () => success({ pullRequests: [] }),
} satisfies Readonly<Record<string, DesktopRoute>>;

export const APP_BOOT_OPERATIONS = {
  setNavigationState: () => success({}),
  setNavigationDestination: () => success({}),
} as const;
