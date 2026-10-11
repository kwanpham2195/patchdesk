import type { Event } from "electron";
import type { GuideReadingAdmission } from "./guide-reading-flush-channel";

type DesktopQuitState = {
  readonly stopping: boolean;
  readonly quitApproved: boolean;
};

/** Orders draft admission and progress confirmation before any window or API teardown. */
export class DesktopOrderlyClose {
  private pending: Promise<void> | undefined;
  private requestedIntent: "window" | "quit" = "window";

  constructor(
    private readonly ports: {
      readonly inspect: () => Promise<GuideReadingAdmission | undefined>;
      readonly confirmDiscard: () => Promise<boolean>;
      readonly flushReading: (
        approval: GuideReadingAdmission,
        retryReading: boolean,
      ) => Promise<GuideReadingAdmission | undefined>;
      readonly holdInput: () => () => void;
      readonly keepOpen: (
        reason: "write_pending" | "reading_unsaved",
      ) => Promise<"retry" | "stay">;
      readonly cancelInstall: () => void;
      readonly complete: (intent: "window" | "quit") => void;
    },
  ) {}

  /** A repeated native quit must not skip the in-flight API shutdown. */
  async beforeQuit(
    event: Pick<Event, "preventDefault">,
    state: DesktopQuitState,
    terminate: () => void,
  ): Promise<void> {
    event.preventDefault();
    if (state.stopping) return;
    if (state.quitApproved) terminate();
    else await this.request("quit");
  }

  /** Concurrent close gestures share admission; Retry attempts persistence again without discarding it. */
  request(intent: "window" | "quit"): Promise<void> {
    if (this.pending !== undefined) {
      if (intent === "quit") this.requestedIntent = "quit";
      return this.pending;
    }
    this.requestedIntent = intent;
    this.pending = this.run().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async run(): Promise<void> {
    let inspected = await this.ports.inspect().catch(() => undefined);
    let approvedRevision: string | undefined;
    let retryReading = false;
    for (;;) {
      if (inspected === undefined) {
        this.ports.cancelInstall();
        if ((await this.ports.keepOpen("reading_unsaved")) !== "retry") return;
        inspected = await this.ports.inspect().catch(() => undefined);
        continue;
      }
      if (inspected.state === "write_pending") {
        this.ports.cancelInstall();
        await this.ports.keepOpen("write_pending");
        return;
      }
      if (
        inspected.state === "dirty_draft" &&
        `${inspected.rendererId}:${inspected.draftRevision}` !==
          approvedRevision &&
        !(await this.ports.confirmDiscard())
      ) {
        this.ports.cancelInstall();
        return;
      }
      approvedRevision = `${inspected.rendererId}:${inspected.draftRevision}`;
      // Native input is held from the final renderer comparison through teardown, not by a DOM interceptor.
      const releaseInput = this.ports.holdInput();
      const admission = await this.ports
        .flushReading(inspected, retryReading)
        .catch(() => undefined);
      if (
        admission?.saved &&
        admission.state !== "write_pending" &&
        admission.draftRevision === inspected.draftRevision &&
        admission.rendererId === inspected.rendererId
      ) {
        const completedIntent = this.requestedIntent;
        this.ports.complete(completedIntent);
        if (completedIntent === "window" && this.requestedIntent === "quit") {
          releaseInput();
          retryReading = false;
          inspected = await this.ports.inspect().catch(() => undefined);
          continue;
        }
        return;
      }
      releaseInput();
      this.ports.cancelInstall();
      if (admission?.state === "write_pending") {
        await this.ports.keepOpen("write_pending");
        return;
      }
      if (
        admission !== undefined &&
        (admission.draftRevision !== inspected.draftRevision ||
          admission.rendererId !== inspected.rendererId)
      ) {
        inspected = admission;
        continue;
      }
      if ((await this.ports.keepOpen("reading_unsaved")) !== "retry") return;
      retryReading = true;
      inspected = await this.ports.inspect().catch(() => undefined);
    }
  }
}

type CloseInputTarget = {
  on(
    event: "before-input-event" | "before-mouse-event",
    listener: (event: { preventDefault(): void }) => void,
  ): void;
  off(
    event: "before-input-event" | "before-mouse-event",
    listener: (event: { preventDefault(): void }) => void,
  ): void;
  once(event: "destroyed", listener: () => void): void;
  off(event: "destroyed", listener: () => void): void;
  setIgnoreMenuShortcuts(ignore: boolean): void;
  isDestroyed(): boolean;
};

/** Holds native input only on the renderer being admitted, until teardown or refusal. */
export function holdDesktopCloseInput(
  target: CloseInputTarget,
  menu: { readonly items: ReadonlyArray<{ enabled: boolean }> } | null,
): () => void {
  const menuItems =
    menu?.items.map((item) => ({ item, enabled: item.enabled })) ?? [];
  for (const { item } of menuItems) item.enabled = false;
  const prevent = (event: { preventDefault(): void }): void =>
    event.preventDefault();
  target.on("before-input-event", prevent);
  target.on("before-mouse-event", prevent);
  target.setIgnoreMenuShortcuts(true);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    for (const { item, enabled } of menuItems) item.enabled = enabled;
    if (target.isDestroyed()) return;
    target.off("destroyed", release);
    target.off("before-input-event", prevent);
    target.off("before-mouse-event", prevent);
    target.setIgnoreMenuShortcuts(false);
  };
  target.once("destroyed", release);
  return release;
}

type CloseDialogOptions = {
  readonly type: "info" | "warning";
  readonly title: string;
  readonly message: string;
  readonly detail?: string;
  readonly buttons: string[];
  readonly defaultId: number;
  readonly cancelId: number;
};

/** Desktop dialog policy keeps progress saving separate from unsaved review text. */
export function desktopCloseDialogs(
  show: (options: CloseDialogOptions) => Promise<{ readonly response: number }>,
): Pick<
  ConstructorParameters<typeof DesktopOrderlyClose>[0],
  "confirmDiscard" | "keepOpen"
> {
  return {
    async confirmDiscard() {
      const result = await show({
        type: "warning",
        title: "Unsaved review draft",
        message: "Discard the unsaved review draft and close Patchdesk?",
        detail:
          "Saved drafts and review history remain on this Mac. Only the latest unsaved edit will be discarded.",
        buttons: ["Keep reviewing", "Discard unsaved changes"],
        defaultId: 0,
        cancelId: 0,
      });
      return result.response === 1;
    },
    async keepOpen(reason) {
      const writePending = reason === "write_pending";
      const result = await show({
        type: writePending ? "info" : "warning",
        title: writePending
          ? "GitHub write in progress"
          : "Guide progress was not saved",
        message: writePending
          ? "Patchdesk must receive the final GitHub result before it can close."
          : "Patchdesk is still open. Retry saving Guide progress before closing.",
        buttons: writePending
          ? ["Wait for completion"]
          : ["Keep reviewing", "Retry"],
        defaultId: 0,
        cancelId: 0,
      });
      return !writePending && result.response === 1 ? "retry" : "stay";
    },
  };
}
