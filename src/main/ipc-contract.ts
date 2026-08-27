import type { RawJsonValue } from "../domain/json";

/** Header accepted by the loopback API for every request. */
export const APP_CAPABILITY_HEADER = "X-Patchdesk-Capability";

/** Opaque local credential shared with the renderer only through preload. */
export type AppCapability = string;

export const DESKTOP_REQUEST_CHANNEL = "patchdesk:request";
export const DESKTOP_NAVIGATE_CHANNEL = "patchdesk:navigate";
export type DesktopDestination = "settings" | "refresh";

/** Allowlisted loopback API request projected through the desktop bridge. */
export type LocalApiDesktopRequest = {
  readonly path: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
};

/** Privileged desktop operation accepted only from the owning renderer. */
export type SelectDirectoryDesktopRequest = {
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
  onNavigate(listener: (destination: DesktopDestination) => void): () => void;
  /** QA-only structural diagnostics are enabled by a main-process argument. */
  readonly qaScrollDiagnosticsEnabled: boolean;
};
