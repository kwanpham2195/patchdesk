import {
  DESKTOP_MENU_ACTION_CHANNEL,
  type DesktopMenuAction,
} from "./ipc-contract";

/**
 * Both halves of the native menu's IPC channel, in one module.
 *
 * The channel name is a runtime string, not a type: if the main process sent
 * on one name and preload listened on another, TypeScript would still compile
 * and the menu would silently stop working. Keeping the send and the
 * subscribe here — rather than each side calling `ipcRenderer`/`webContents`
 * with its own literal — puts both halves behind one constant and behind one
 * test (`tests/main/desktop-menu-channel.test.ts`) that drives a real send
 * into a real subscription. Neither side is reachable from a plain Vitest
 * process on its own: `preload.ts` needs Electron's `contextBridge`, and
 * `electron-main.ts` needs `app`. These two functions are the seam that is.
 */

type MenuActionHandler<Event> = (
  event: Event,
  action: DesktopMenuAction,
) => void;

/** The main-process half: `BrowserWindow.webContents`, structurally. */
type MenuActionSender = {
  send(channel: string, action: DesktopMenuAction): void;
};

/** The preload half: Electron's `ipcRenderer`, structurally. */
type MenuActionReceiver<Event> = {
  on(channel: string, handler: MenuActionHandler<Event>): void;
  off(channel: string, handler: MenuActionHandler<Event>): void;
};

/** Delivers one native-menu action to the renderer. */
export function sendMenuAction(
  sender: MenuActionSender,
  action: DesktopMenuAction,
): void {
  sender.send(DESKTOP_MENU_ACTION_CHANNEL, action);
}

/** Listens for native-menu actions; the returned function stops listening. */
export function subscribeToMenuActions<Event>(
  receiver: MenuActionReceiver<Event>,
  listener: (action: DesktopMenuAction) => void,
): () => void {
  const handler: MenuActionHandler<Event> = (_event, action) =>
    listener(action);
  receiver.on(DESKTOP_MENU_ACTION_CHANNEL, handler);
  return () => receiver.off(DESKTOP_MENU_ACTION_CHANNEL, handler);
}
