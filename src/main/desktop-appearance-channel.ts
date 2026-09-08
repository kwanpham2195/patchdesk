import type { Appearance } from "../domain/contracts";
import { DESKTOP_WINDOW_APPEARANCE_CHANNEL } from "./ipc-contract";

/**
 * Every half of the window-appearance channel, in one module, for the reason
 * `desktop-full-screen-channel.ts` gives: a channel name is a runtime string,
 * so two halves naming different literals would still compile and the window
 * would keep painting the appearance the user left.
 *
 * The channel carries both directions on one name. A message with no payload
 * is preload's synchronous read of the appearance the main process took from
 * `config.json` before the window existed; a message carrying an appearance
 * is the renderer reporting the one it now paints. The read is synchronous
 * because the renderer applies it before its first render: an awaited seed
 * would paint one frame of the theme the user did not choose.
 *
 * Neither side is reachable from a plain Vitest process on its own, so these
 * functions are the seam that is, and
 * `tests/main/desktop-appearance-channel.test.ts` drives them across one fake
 * IPC bus.
 */

/** The preload read half: Electron's `ipcRenderer`, structurally. */
type AppearanceReader = {
  sendSync(channel: string): Appearance | undefined;
};

/** The preload report half: Electron's `ipcRenderer`, structurally. */
type AppearanceSender = {
  send(channel: string, appearance: Appearance): void;
};

/** One message from preload; `sender` identifies the renderer. */
type AppearanceEvent = {
  returnValue: Appearance;
  readonly sender: { readonly id: number };
};

/** The main-process half: Electron's `ipcMain`, structurally. */
type AppearanceHost<Event extends AppearanceEvent> = {
  on(
    channel: string,
    handler: (event: Event, appearance: Appearance | undefined) => void,
  ): void;
  removeAllListeners(channel: string): void;
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the IPC message boundary itself; the payload arrives from the renderer as an untyped value and this is the parser that names it.
function isAppearance(value: unknown): value is Appearance {
  return value === "system" || value === "light" || value === "dark";
}

/** Reads the stored appearance, blocking until the main process answers. */
export function readWindowAppearance(reader: AppearanceReader): Appearance {
  const answer = reader.sendSync(DESKTOP_WINDOW_APPEARANCE_CHANNEL);
  return isAppearance(answer) ? answer : "system";
}

/** Reports the appearance the renderer now paints to the main process. */
export function sendWindowAppearance(
  sender: AppearanceSender,
  appearance: Appearance,
): void {
  sender.send(DESKTOP_WINDOW_APPEARANCE_CHANNEL, appearance);
}

/**
 * Answers `readWindowAppearance` and applies `sendWindowAppearance` for one
 * window. Only that window's renderer is served, the same sender check
 * `installDesktopRequestBridge` makes; any other frame is told `"system"` and
 * cannot repaint the window.
 */
export function serveWindowAppearance<Event extends AppearanceEvent>(
  host: AppearanceHost<Event>,
  senderId: number,
  window: {
    readonly current: () => Appearance;
    readonly update: (appearance: Appearance) => void;
  },
): void {
  host.removeAllListeners(DESKTOP_WINDOW_APPEARANCE_CHANNEL);
  host.on(DESKTOP_WINDOW_APPEARANCE_CHANNEL, (event, appearance) => {
    if (event.sender.id !== senderId) {
      event.returnValue = "system";
      return;
    }
    if (!isAppearance(appearance)) {
      event.returnValue = window.current();
      return;
    }
    window.update(appearance);
  });
}
