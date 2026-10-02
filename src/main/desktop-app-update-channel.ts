import type { AppUpdateState } from "../domain/app-update";
import { DESKTOP_APP_UPDATE_CHANNEL } from "./ipc-contract";

/**
 * Every half of the in-app update state channel (#800), in one module, for
 * the reason `desktop-full-screen-channel.ts` gives: a channel name is a
 * runtime string, so two halves naming different literals would still
 * compile and the title bar would never show a release.
 *
 * Main pushes the state whenever it changes; preload reads the current state
 * once, synchronously, while it builds `window.patchdesk`, so a renderer
 * loaded after the check still shows its result. The renderer's requests —
 * Dismiss and Update now — go over the desktop request bridge.
 * `tests/main/desktop-app-update-channel.test.ts` drives every half across
 * one fake IPC bus.
 */

type AppUpdateHandler<Event> = (event: Event, state: AppUpdateState) => void;

/** The main-process push half: `BrowserWindow.webContents`, structurally. */
export type AppUpdateSender = {
  send(channel: string, state: AppUpdateState): void;
};

/** The preload subscribe half: Electron's `ipcRenderer`, structurally. */
type AppUpdateReceiver<Event> = {
  on(channel: string, handler: AppUpdateHandler<Event>): void;
  off(channel: string, handler: AppUpdateHandler<Event>): void;
};

/** The preload read half; `undefined` is what Electron hands back when nothing answered. */
type AppUpdateReader = {
  sendSync(channel: string): AppUpdateState | undefined;
};

/** One synchronous read from preload; `sender` identifies the renderer. */
type AppUpdateReadEvent = {
  returnValue: AppUpdateState;
  readonly sender: { readonly id: number };
};

/** The main-process read half: Electron's `ipcMain`, structurally. */
type AppUpdateReadHost<Event extends AppUpdateReadEvent> = {
  on(channel: string, handler: (event: Event) => void): void;
  removeAllListeners(channel: string): void;
};

/** Tells the renderer the update state changed. */
export function sendAppUpdate(
  sender: AppUpdateSender,
  state: AppUpdateState,
): void {
  sender.send(DESKTOP_APP_UPDATE_CHANNEL, state);
}

/** Listens for update state changes; the returned function stops listening. */
export function subscribeToAppUpdate<Event>(
  receiver: AppUpdateReceiver<Event>,
  listener: (state: AppUpdateState) => void,
): () => void {
  const handler: AppUpdateHandler<Event> = (_event, state) => listener(state);
  receiver.on(DESKTOP_APP_UPDATE_CHANNEL, handler);
  return () => receiver.off(DESKTOP_APP_UPDATE_CHANNEL, handler);
}

/** Reads the current update state, blocking until main answers. */
export function readAppUpdate(reader: AppUpdateReader): AppUpdateState {
  return reader.sendSync(DESKTOP_APP_UPDATE_CHANNEL) ?? {};
}

/**
 * Answers `readAppUpdate` for one window. Any other frame is told there is
 * nothing to show, the same sender check `installDesktopRequestBridge` makes.
 */
export function answerAppUpdateReads<Event extends AppUpdateReadEvent>(
  host: AppUpdateReadHost<Event>,
  senderId: number,
  current: () => AppUpdateState,
): void {
  host.removeAllListeners(DESKTOP_APP_UPDATE_CHANNEL);
  host.on(DESKTOP_APP_UPDATE_CHANNEL, (event) => {
    event.returnValue = event.sender.id === senderId ? current() : {};
  });
}
