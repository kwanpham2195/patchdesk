import { contextBridge, ipcRenderer } from "electron";

import {
  DESKTOP_NAVIGATE_CHANNEL,
  DESKTOP_REQUEST_CHANNEL,
  type DesktopDestination,
  type DesktopRequest,
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
    const response = await ipcRenderer.invoke(DESKTOP_REQUEST_CHANNEL, {
      operation: "openExternalHttps",
      url,
    } satisfies DesktopRequest);
    if (
      !response.ok ||
      typeof response.body !== "object" ||
      response.body === null
    ) {
      return false;
    }
    return "opened" in response.body && response.body.opened === true;
  },
  onNavigate(listener: (destination: DesktopDestination) => void) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      destination: DesktopDestination,
    ): void => listener(destination);
    ipcRenderer.on(DESKTOP_NAVIGATE_CHANNEL, handler);
    return () => ipcRenderer.off(DESKTOP_NAVIGATE_CHANNEL, handler);
  },
  qaScrollDiagnosticsEnabled,
});

contextBridge.exposeInMainWorld("patchdesk", desktopApi);
