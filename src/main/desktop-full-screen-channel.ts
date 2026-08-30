import { DESKTOP_WINDOW_FULL_SCREEN_CHANNEL } from "./ipc-contract";

/**
 * Every half of the window's full-screen channel, in one module, for the
 * reason `desktop-menu-channel.ts` gives: a channel name is a runtime string,
 * so two halves that named different literals would still compile and the
 * header would silently keep its full-screen inset forever.
 *
 * The channel carries both directions. Main pushes a boolean on
 * `enter-full-screen` and `leave-full-screen`; preload reads the current
 * value once, synchronously, while it is building `window.patchdesk`. The
 * read is synchronous because a reload inside full screen must paint the
 * right header on its first frame: an awaited seed would show one frame of
 * the 6rem inset that keeps the brand clear of traffic lights macOS has
 * already hidden.
 *
 * Neither side is reachable from a plain Vitest process on its own —
 * `preload.ts` needs Electron's `contextBridge` and `electron-main.ts` needs
 * `app` — so these functions are the seam that is, and
 * `tests/main/desktop-full-screen-channel.test.ts` drives them across one
 * fake IPC bus.
 */

type FullScreenHandler<Event> = (event: Event, fullScreen: boolean) => void;

/** The main-process push half: `BrowserWindow.webContents`, structurally. */
type FullScreenSender = {
  send(channel: string, fullScreen: boolean): void;
};

/** The preload subscribe half: Electron's `ipcRenderer`, structurally. */
type FullScreenReceiver<Event> = {
  on(channel: string, handler: FullScreenHandler<Event>): void;
  off(channel: string, handler: FullScreenHandler<Event>): void;
};

/**
 * The preload read half: Electron's `ipcRenderer`, structurally. `undefined`
 * is what Electron hands back when nothing on the main side answered.
 */
type FullScreenReader = {
  sendSync(channel: string): boolean | undefined;
};

/** One synchronous read from preload; `sender` identifies the renderer. */
type FullScreenReadEvent = {
  returnValue: boolean;
  readonly sender: { readonly id: number };
};

/** The main-process read half: Electron's `ipcMain`, structurally. */
type FullScreenReadHost<Event extends FullScreenReadEvent> = {
  on(channel: string, handler: (event: Event) => void): void;
  removeAllListeners(channel: string): void;
};

/** Tells the renderer the window entered or left native full screen. */
export function sendWindowFullScreen(
  sender: FullScreenSender,
  fullScreen: boolean,
): void {
  sender.send(DESKTOP_WINDOW_FULL_SCREEN_CHANNEL, fullScreen);
}

/** Listens for full-screen transitions; the returned function stops listening. */
export function subscribeToWindowFullScreen<Event>(
  receiver: FullScreenReceiver<Event>,
  listener: (fullScreen: boolean) => void,
): () => void {
  const handler: FullScreenHandler<Event> = (_event, fullScreen) =>
    listener(fullScreen);
  receiver.on(DESKTOP_WINDOW_FULL_SCREEN_CHANNEL, handler);
  return () => receiver.off(DESKTOP_WINDOW_FULL_SCREEN_CHANNEL, handler);
}

/** Reads the window's current full-screen state, blocking until main answers. */
export function readWindowFullScreen(reader: FullScreenReader): boolean {
  return reader.sendSync(DESKTOP_WINDOW_FULL_SCREEN_CHANNEL) === true;
}

/**
 * Answers `readWindowFullScreen` for one window. Only that window's renderer
 * is answered, the same sender check `installDesktopRequestBridge` makes; any
 * other frame is told `false` rather than being given the window's state.
 */
export function answerWindowFullScreenReads<Event extends FullScreenReadEvent>(
  host: FullScreenReadHost<Event>,
  senderId: number,
  isFullScreen: () => boolean,
): void {
  host.removeAllListeners(DESKTOP_WINDOW_FULL_SCREEN_CHANNEL);
  host.on(DESKTOP_WINDOW_FULL_SCREEN_CHANNEL, (event) => {
    event.returnValue = event.sender.id === senderId && isFullScreen();
  });
}
