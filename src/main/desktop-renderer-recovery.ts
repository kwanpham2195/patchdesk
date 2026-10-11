import type { BrowserWindow, MessageBoxOptions } from "electron";
import type { DesktopNavigationState } from "./desktop-close-guard";
import type { desktopCloseDialogs } from "./desktop-orderly-close";

type RecoveryWindow = Pick<BrowserWindow, "isDestroyed" | "reload">;

/** Only an explicit recovery choice for the current crashed renderer can skip its unavailable acknowledgment. */
export class DesktopRendererRecovery<Window extends RecoveryWindow> {
  private readonly pending = new WeakMap<Window, Promise<void>>();

  constructor(
    private readonly ports: {
      readonly current: () => Window | undefined;
      readonly isFailed: (window: Window) => boolean;
      readonly navigationState: () => DesktopNavigationState;
      readonly show: (
        window: Window,
        options: MessageBoxOptions,
      ) => Promise<{ readonly response: number }>;
      readonly dialogs: ReturnType<typeof desktopCloseDialogs>;
      readonly cancelInstall: () => void;
      readonly requestQuit: () => void;
      readonly approveQuit: () => void;
    },
  ) {}

  /** Repeated failure events share the same decision for this window. */
  offer(window: Window, message: string): Promise<void> {
    const pending = this.pending.get(window);
    if (pending !== undefined) return pending;
    const decision = this.run(window, message).finally(() => {
      this.pending.delete(window);
    });
    this.pending.set(window, decision);
    return decision;
  }

  private async run(window: Window, message: string): Promise<void> {
    if (window.isDestroyed() || this.ports.current() !== window) return;
    const choice = await this.ports.show(window, {
      type: "warning",
      title: "Patchdesk recovery",
      message,
      detail:
        "Reloading restores saved local state and never retries a GitHub write.",
      buttons: ["Reload Patchdesk", "Quit"],
      defaultId: 0,
      cancelId: 1,
    });
    if (window.isDestroyed() || this.ports.current() !== window) return;
    if (choice.response === 0) {
      window.reload();
      return;
    }
    for (;;) {
      if (!this.ports.isFailed(window)) {
        this.ports.requestQuit();
        return;
      }
      const state = this.ports.navigationState();
      if (state === "write_pending") {
        this.ports.cancelInstall();
        await this.ports.dialogs.keepOpen("write_pending");
        return;
      }
      if (state === "dirty_draft") {
        const discarded = await this.ports.dialogs.confirmDiscard();
        if (!discarded) {
          this.ports.cancelInstall();
          return;
        }
      }
      if (window.isDestroyed() || this.ports.current() !== window) return;
      if (!this.ports.isFailed(window)) {
        this.ports.requestQuit();
        return;
      }
      if (this.ports.navigationState() !== state) continue;
      // The renderer has already stopped; only confirmed progress can survive this recovery exit.
      this.ports.approveQuit();
      return;
    }
  }
}
