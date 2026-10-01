import { DESKTOP_REVIEWS_REMOVED_CHANNEL } from "./ipc-contract";

/**
 * Both halves of the reviews-removed channel, for the reason
 * `desktop-menu-channel.ts` gives: the channel name is a runtime string, so
 * the send and the subscribe share one constant and one test.
 */

type RemovedHandler<Event> = (event: Event) => void;

/** The main-process half: `BrowserWindow.webContents`, structurally. */
type RemovedSender = {
  send(channel: string): void;
};

/** The preload half: Electron's `ipcRenderer`, structurally. */
type RemovedReceiver<Event> = {
  on(channel: string, handler: RemovedHandler<Event>): void;
  off(channel: string, handler: RemovedHandler<Event>): void;
};

/** Tells the renderer the retention sweep removed Reviews, so it re-reads the local Review list it shows. */
export function sendReviewsRemoved(sender: RemovedSender): void {
  sender.send(DESKTOP_REVIEWS_REMOVED_CHANNEL);
}

/** Listens for sweeps that removed Reviews; the returned function stops listening. */
export function subscribeToReviewsRemoved<Event>(
  receiver: RemovedReceiver<Event>,
  listener: () => void,
): () => void {
  const handler: RemovedHandler<Event> = () => listener();
  receiver.on(DESKTOP_REVIEWS_REMOVED_CHANNEL, handler);
  return () => receiver.off(DESKTOP_REVIEWS_REMOVED_CHANNEL, handler);
}
