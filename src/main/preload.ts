import { contextBridge, ipcRenderer } from "electron";

import { subscribeToMenuActions } from "./desktop-menu-channel";
import {
  DESKTOP_REQUEST_CHANNEL,
  type DesktopMenuAction,
  type DesktopRequest,
  type DesktopResponse,
  type PatchdeskDesktopApi,
} from "./ipc-contract";

const qaScrollDiagnosticsEnabled = process.argv.includes(
  "--patchdesk-qa-scroll-diagnostics=1",
);

const desktopApi: PatchdeskDesktopApi = Object.freeze({
  async request(input: DesktopRequest) {
    return await ipcRenderer.invoke(DESKTOP_REQUEST_CHANNEL, input);
  },
  async openExternalHttps(url: string): Promise<boolean> {
    const response: DesktopResponse = await ipcRenderer.invoke(
      DESKTOP_REQUEST_CHANNEL,
      {
        operation: "openExternalHttps",
        url,
      } satisfies DesktopRequest,
    );
    const body = response.body;
    return (
      response.ok &&
      body instanceof Object &&
      "opened" in body &&
      body.opened === true
    );
  },
  onMenuAction(listener: (action: DesktopMenuAction) => void) {
    return subscribeToMenuActions(ipcRenderer, listener);
  },
  qaScrollDiagnosticsEnabled,
});

contextBridge.exposeInMainWorld("patchdesk", desktopApi);
