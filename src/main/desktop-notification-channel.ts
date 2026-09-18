import {
  DESKTOP_NOTIFICATION_CLICK_CHANNEL,
  type DesktopNotificationClick,
} from "./ipc-contract";

/**
 * Both halves of the notification-click channel, for the reason
 * `desktop-menu-channel.ts` gives: the channel name is a runtime string, so
 * the send and the subscribe share one constant and one test.
 */

type NotificationClickHandler<Event> = (
  event: Event,
  click: DesktopNotificationClick,
) => void;

/** The main-process half: `BrowserWindow.webContents`, structurally. */
type NotificationClickSender = {
  send(channel: string, click: DesktopNotificationClick): void;
};

/** The preload half: Electron's `ipcRenderer`, structurally. */
type NotificationClickReceiver<Event> = {
  on(channel: string, handler: NotificationClickHandler<Event>): void;
  off(channel: string, handler: NotificationClickHandler<Event>): void;
};

/** Tells the renderer which Review a clicked notification belongs to. */
export function sendNotificationClick(
  sender: NotificationClickSender,
  click: DesktopNotificationClick,
): void {
  sender.send(DESKTOP_NOTIFICATION_CLICK_CHANNEL, click);
}

/** Listens for notification clicks; the returned function stops listening. */
export function subscribeToNotificationClicks<Event>(
  receiver: NotificationClickReceiver<Event>,
  listener: (click: DesktopNotificationClick) => void,
): () => void {
  const handler: NotificationClickHandler<Event> = (_event, click) =>
    listener(click);
  receiver.on(DESKTOP_NOTIFICATION_CLICK_CHANNEL, handler);
  return () => receiver.off(DESKTOP_NOTIFICATION_CLICK_CHANNEL, handler);
}
