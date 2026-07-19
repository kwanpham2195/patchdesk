import type { PatchdeskDesktopApi } from "../../main/ipc-contract";

declare global {
  interface Window {
    readonly patchdesk: PatchdeskDesktopApi;
  }
}

export {};
