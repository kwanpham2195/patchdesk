import type { PatchdeskDesktopApi } from "#src/main/ipc-contract";

declare global {
  interface Window {
    readonly patchdesk: PatchdeskDesktopApi;
  }
  interface WindowEventMap {
    "patchdesk:inbox-view": CustomEvent<string>;
    "patchdesk:inbox-action": Event;
  }
}

export {};
