import { contextBridge, ipcRenderer } from "electron";

import {
  DESKTOP_NAVIGATE_CHANNEL,
  DESKTOP_REQUEST_CHANNEL,
  type DesktopDestination,
  type DesktopRequest,
  type PatchdeskDesktopApi,
} from "./ipc-contract";

const desktopApi: PatchdeskDesktopApi = Object.freeze({
  async request(input: DesktopRequest) {
    return await ipcRenderer.invoke(DESKTOP_REQUEST_CHANNEL, input);
  },
  onNavigate(listener: (destination: DesktopDestination) => void) {
    const handler = (_event: Electron.IpcRendererEvent, destination: DesktopDestination): void => listener(destination);
    ipcRenderer.on(DESKTOP_NAVIGATE_CHANNEL, handler);
    return () => ipcRenderer.off(DESKTOP_NAVIGATE_CHANNEL, handler);
  },
});

contextBridge.exposeInMainWorld("patchdesk", desktopApi);
