import { DESKTOP_INSIGHT_SETTLED_CHANNEL } from "./ipc-contract";

/**
 * Both halves of the Insight-settled channel, for the reason
 * `desktop-menu-channel.ts` gives: the channel name is a runtime string, so
 * the send and the subscribe share one constant and one test.
 */

type SettledHandler<Event> = (event: Event) => void;

/** The main-process half: `BrowserWindow.webContents`, structurally. */
type SettledSender = {
  send(channel: string): void;
};

/** The preload half: Electron's `ipcRenderer`, structurally. */
type SettledReceiver<Event> = {
  on(channel: string, handler: SettledHandler<Event>): void;
  off(channel: string, handler: SettledHandler<Event>): void;
};

/** Tells the renderer an Insight run finished or failed, so it re-reads the local Insight state it shows. */
export function sendInsightSettled(sender: SettledSender): void {
  sender.send(DESKTOP_INSIGHT_SETTLED_CHANNEL);
}

/** Listens for settled Insight runs; the returned function stops listening. */
export function subscribeToInsightSettled<Event>(
  receiver: SettledReceiver<Event>,
  listener: () => void,
): () => void {
  const handler: SettledHandler<Event> = () => listener();
  receiver.on(DESKTOP_INSIGHT_SETTLED_CHANNEL, handler);
  return () => receiver.off(DESKTOP_INSIGHT_SETTLED_CHANNEL, handler);
}
