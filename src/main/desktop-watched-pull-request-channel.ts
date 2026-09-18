import { DESKTOP_WATCHED_PULL_REQUEST_CHANGE_CHANNEL } from "./ipc-contract";

/**
 * Both halves of the watched-pull-request change channel, for the reason
 * `desktop-menu-channel.ts` gives: the channel name is a runtime string, so
 * the send and the subscribe share one constant and one test.
 */

type ChangeHandler<Event> = (event: Event, profileId: string) => void;

/** The main-process half: `BrowserWindow.webContents`, structurally. */
type ChangeSender = {
  send(channel: string, profileId: string): void;
};

/** The preload half: Electron's `ipcRenderer`, structurally. */
type ChangeReceiver<Event> = {
  on(channel: string, handler: ChangeHandler<Event>): void;
  off(channel: string, handler: ChangeHandler<Event>): void;
};

/** Tells the renderer a poll found a change on a watched pull request of `profileId`. */
export function sendWatchedPullRequestChange(
  sender: ChangeSender,
  profileId: string,
): void {
  sender.send(DESKTOP_WATCHED_PULL_REQUEST_CHANGE_CHANNEL, profileId);
}

/** Listens for watched pull request changes; the returned function stops listening. */
export function subscribeToWatchedPullRequestChanges<Event>(
  receiver: ChangeReceiver<Event>,
  listener: (profileId: string) => void,
): () => void {
  const handler: ChangeHandler<Event> = (_event, profileId) =>
    listener(profileId);
  receiver.on(DESKTOP_WATCHED_PULL_REQUEST_CHANGE_CHANNEL, handler);
  return () =>
    receiver.off(DESKTOP_WATCHED_PULL_REQUEST_CHANGE_CHANNEL, handler);
}
