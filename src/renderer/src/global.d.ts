import type { RendererLocalApi } from "../../main/ipc-contract";

declare global {
  interface Window {
    readonly patchdesk: {
      readonly localApi: RendererLocalApi;
    };
  }
}

export {};
