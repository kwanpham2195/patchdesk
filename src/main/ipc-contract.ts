import type { Appearance } from "../domain/contracts";
import type { RawJsonValue } from "../domain/json";

/** Header accepted by the loopback API for every request. */
export const APP_CAPABILITY_HEADER = "X-Patchdesk-Capability";

/** Opaque local credential shared with the renderer only through preload. */
export type AppCapability = string;

export const DESKTOP_REQUEST_CHANNEL = "patchdesk:request";
/**
 * The one channel the native menu uses to reach the renderer. Both halves —
 * `sendMenuAction` in the main process and `subscribeToMenuActions` in
 * preload, both in `desktop-menu-channel.ts` — read this constant, so the
 * literal below is written exactly once in the repository. A menu action is
 * not navigation: "refresh" re-reads the screen the maintainer is already on.
 */
export const DESKTOP_MENU_ACTION_CHANNEL = "patchdesk:menu-action";
export type DesktopMenuAction = "openSettings" | "refresh";

/**
 * The window's native-full-screen state, both directions on one channel.
 * `desktop-full-screen-channel.ts` holds every half — main's push, preload's
 * synchronous read of the current value, and preload's subscription — so the
 * literal below is written exactly once in the repository.
 */
export const DESKTOP_WINDOW_FULL_SCREEN_CHANNEL =
  "patchdesk:window-full-screen";

/**
 * The stored appearance, both directions on one channel, for the reason
 * `desktop-menu-channel.ts` gives about channel names being runtime strings.
 * `desktop-appearance-channel.ts` holds every half: preload reads the current
 * value synchronously while it builds `window.patchdesk`, and sends the new
 * value whenever the renderer repaints in a different appearance, so the
 * window's native background never keeps the theme the user just left.
 */
export const DESKTOP_WINDOW_APPEARANCE_CHANNEL = "patchdesk:window-appearance";

/** Allowlisted loopback API request projected through the desktop bridge. */
export type LocalApiDesktopRequest = {
  readonly path: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
};

/** Privileged desktop operation accepted only from the owning renderer. */
type SelectDirectoryDesktopRequest = {
  readonly operation: "selectDirectory";
  readonly defaultPath?: string;
};

type SetNavigationStateDesktopRequest = {
  readonly operation: "setNavigationState";
  readonly state: "clear" | "dirty_draft" | "write_pending";
};

/** Opens a validated HTTPS URL outside the isolated renderer. */
type OpenExternalHttpsDesktopRequest = {
  readonly operation: "openExternalHttps";
  readonly url: string;
};

/** Closed renderer-to-main request union. */
export type DesktopRequest =
  | LocalApiDesktopRequest
  | SelectDirectoryDesktopRequest
  | SetNavigationStateDesktopRequest
  | OpenExternalHttpsDesktopRequest;

export type DesktopResponse = {
  readonly ok: boolean;
  readonly status: number;
  /**
   * The local API's response body, as the JSON grammar it always is: the
   * bridge only ever fills it from `JSON.parse` output or its own object
   * literals. Naming the grammar rather than `unknown` lets the renderer's
   * `requestJson` hand every call site a real type to run its own parser
   * against, with no assertion in between.
   */
  readonly body: RawJsonValue | undefined;
  readonly correlationId: string;
};

/** The renderer-visible API contains operations, never loopback credentials. */
export type PatchdeskDesktopApi = {
  request(input: DesktopRequest): Promise<DesktopResponse>;
  openExternalHttps(url: string): Promise<boolean>;
  onMenuAction(listener: (action: DesktopMenuAction) => void): () => void;
  /**
   * Fires whenever the window enters or leaves native macOS full screen,
   * which the renderer cannot observe on its own: `(display-mode:
   * fullscreen)` stays false in an Electron renderer. macOS hides the traffic
   * lights in full screen, so the header's left inset is dead space there.
   */
  onWindowFullScreen(listener: (fullScreen: boolean) => void): () => void;
  /**
   * The window's full-screen state as this renderer loaded, read
   * synchronously in preload so a reload inside full screen paints the right
   * header on its first frame.
   */
  readonly windowFullScreenAtLoad: boolean;
  /**
   * The stored appearance as this renderer loaded, read synchronously in
   * preload from the main process, which took it from `config.json` before
   * the window existed. The renderer applies it before its first render, so
   * the first frame is never the theme the user did not choose.
   */
  readonly appearanceAtLoad: Appearance;
  /**
   * Tells the main process which appearance the renderer now paints, so the
   * window's native background colour follows a change made in Settings.
   */
  setWindowAppearance(appearance: Appearance): void;
  /** QA-only structural diagnostics are enabled by a main-process argument. */
  readonly qaScrollDiagnosticsEnabled: boolean;
};
