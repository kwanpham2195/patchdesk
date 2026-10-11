import { describe, expect, it } from "vitest";
import {
  DesktopOrderlyClose,
  holdDesktopCloseInput,
} from "#src/main/desktop-orderly-close";
import type { DesktopNavigationState } from "#src/main/desktop-close-guard";
import type { GuideReadingAdmission } from "#src/main/guide-reading-flush-channel";

function setup(state: DesktopNavigationState = "clear") {
  const events: string[] = [];
  let navigationState = state;
  let saved = true;
  let retry: "retry" | "stay" = "stay";
  let discard = false;
  const close = new DesktopOrderlyClose({
    inspect: async () => ({
      state: navigationState,
      draftRevision: 0,
      rendererId: "renderer",
      saved: false,
    }),
    holdInput: () => () => undefined,
    async confirmDiscard() {
      events.push("discard requested");
      return discard;
    },
    async flushReading() {
      events.push("save");
      return {
        saved,
        state: navigationState,
        draftRevision: 0,
        rendererId: "renderer",
      };
    },
    async keepOpen(reason) {
      events.push(reason);
      const answer = retry;
      retry = "stay";
      saved = true;
      return answer;
    },
    cancelInstall() {
      events.push("cancel install");
    },
    complete(intent) {
      events.push(intent === "quit" ? "stop API and quit" : "close window");
    },
  });
  return {
    close,
    events,
    failSave() {
      saved = false;
    },
    retrySave() {
      retry = "retry";
    },
    discardDraft() {
      discard = true;
    },
    startWrite() {
      navigationState = "write_pending";
    },
  };
}

describe("orderly desktop close", () => {
  it("prevents another native quit while API shutdown is pending", async () => {
    const desktop = setup();
    let prevented = false;
    let restarted = false;
    await desktop.close.beforeQuit(
      {
        preventDefault() {
          prevented = true;
        },
      },
      { stopping: true, quitApproved: true },
      () => {
        restarted = true;
      },
    );
    expect(prevented).toBe(true);
    expect(restarted).toBe(false);
    expect(desktop.events).toEqual([]);
  });

  it("starts approved shutdown after preventing native default exit", async () => {
    const desktop = setup();
    const events: string[] = [];
    await desktop.close.beforeQuit(
      {
        preventDefault() {
          events.push("prevent");
        },
      },
      { stopping: false, quitApproved: true },
      () => {
        events.push("API shutdown");
      },
    );
    expect(events).toEqual(["prevent", "API shutdown"]);
    expect(desktop.events).toEqual([]);
  });

  it("admits native quit through reading confirmation before completion", async () => {
    const desktop = setup();
    let prevented = false;
    await desktop.close.beforeQuit(
      {
        preventDefault() {
          prevented = true;
        },
      },
      { stopping: false, quitApproved: false },
      () => {
        desktop.events.push("premature API shutdown");
      },
    );
    expect(prevented).toBe(true);
    expect(desktop.events).toEqual(["save", "stop API and quit"]);
  });

  it.each(["refusal", "destruction"] as const)(
    "holds native input through admission and restores menus on %s",
    (ending) => {
      const listeners = new Map<
        string,
        Set<(event: { preventDefault(): void }) => void>
      >();
      let gone = false;
      let shortcutsIgnored = false;
      const target = {
        on(
          event: "before-input-event" | "before-mouse-event",
          listener: (event: { preventDefault(): void }) => void,
        ) {
          const current = listeners.get(event) ?? new Set();
          current.add(listener);
          listeners.set(event, current);
        },
        off(
          event: "before-input-event" | "before-mouse-event" | "destroyed",
          listener: (event: { preventDefault(): void }) => void,
        ) {
          listeners.get(event)?.delete(listener);
        },
        once(event: "destroyed", listener: () => void) {
          const current = listeners.get(event) ?? new Set();
          current.add(listener);
          listeners.set(event, current);
        },
        setIgnoreMenuShortcuts(ignore: boolean) {
          shortcutsIgnored = ignore;
        },
        isDestroyed: () => gone,
      };
      const menu = { items: [{ enabled: true }, { enabled: false }] };
      const release = holdDesktopCloseInput(target, menu);
      let prevented = false;
      const nativeEvent = {
        preventDefault() {
          prevented = true;
        },
      };
      for (const listener of listeners.get("before-input-event") ?? [])
        listener(nativeEvent);
      expect(prevented).toBe(true);
      prevented = false;
      for (const listener of listeners.get("before-mouse-event") ?? [])
        listener(nativeEvent);
      expect(prevented).toBe(true);
      expect(shortcutsIgnored).toBe(true);
      expect(menu.items.map((item) => item.enabled)).toEqual([false, false]);
      if (ending === "destruction") {
        gone = true;
        for (const listener of listeners.get("destroyed") ?? [])
          listener(nativeEvent);
      } else {
        release();
        prevented = false;
        for (const listener of listeners.get("before-input-event") ?? [])
          listener(nativeEvent);
        expect(prevented).toBe(false);
        expect(shortcutsIgnored).toBe(false);
      }
      expect(menu.items.map((item) => item.enabled)).toEqual([true, false]);
    },
  );

  it.each(["clear", "dirty_draft"] as const)(
    "keeps newly edited text alive after an awaited flush from %s",
    async (initialState) => {
      const events: string[] = [];
      let current: GuideReadingAdmission = {
        state: initialState,
        draftRevision: 0,
        rendererId: "renderer",
        saved: false,
      };
      let finish: (() => void) | undefined;
      let start: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        start = resolve;
      });
      const saving = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let decision = 0;
      const close = new DesktopOrderlyClose({
        inspect: async () => current,
        async confirmDiscard() {
          decision += 1;
          events.push("decision");
          return initialState === "dirty_draft" && decision === 1;
        },
        holdInput: () => () => {
          events.push("input released");
        },
        async flushReading() {
          start?.();
          await saving;
          return { ...current, saved: true };
        },
        keepOpen: async () => "stay",
        cancelInstall: () => {
          events.push("cancel install");
        },
        complete: () => {
          events.push("teardown");
        },
      });
      const closing = close.request("quit");
      await started;
      current = { ...current, state: "dirty_draft", draftRevision: 1 };
      finish?.();
      await closing;
      expect(events).not.toContain("teardown");
      expect(events).toContain("input released");
      expect(decision).toBe(initialState === "dirty_draft" ? 2 : 1);
    },
  );

  it("does not ask again for unchanged approved text after the reviewer chooses Retry", async () => {
    const desktop = setup("dirty_draft");
    desktop.discardDraft();
    desktop.failSave();
    desktop.retrySave();
    await desktop.close.request("quit");
    expect(
      desktop.events.filter((event) => event === "discard requested"),
    ).toHaveLength(1);
    expect(desktop.events.at(-1)).toBe("stop API and quit");
  });

  it.each(["window", "quit"] as const)(
    "flushes a clear-state %s before teardown",
    async (intent) => {
      const desktop = setup();
      await desktop.close.request(intent);
      expect(desktop.events).toEqual([
        "save",
        intent === "quit" ? "stop API and quit" : "close window",
      ]);
    },
  );

  it("honors native quit emitted synchronously by window completion", async () => {
    const completed: string[] = [];
    const close = new DesktopOrderlyClose({
      inspect: async () => ({
        state: "clear",
        rendererId: "renderer",
        draftRevision: 0,
        saved: false,
      }),
      holdInput: () => () => undefined,
      confirmDiscard: async () => false,
      flushReading: async (approval) => ({ ...approval, saved: true }),
      keepOpen: async () => "stay",
      cancelInstall: () => undefined,
      complete(intent) {
        completed.push(intent);
        if (intent === "window")
          void close.beforeQuit(
            { preventDefault() {} },
            { stopping: false, quitApproved: false },
            () => {
              completed.push("premature API shutdown");
            },
          );
      },
    });
    await close.request("window");
    expect(completed).toEqual(["window", "quit"]);
  });

  it("honors a quit gesture received while a window close is saving", async () => {
    const desktop = setup();
    await Promise.all([
      desktop.close.request("window"),
      desktop.close.request("quit"),
    ]);
    expect(desktop.events).toEqual(["save", "stop API and quit"]);
  });

  it("keeps the window and API alive when saving fails, then allows a later Retry", async () => {
    const desktop = setup();
    desktop.failSave();
    await desktop.close.request("quit");
    expect(desktop.events).toEqual([
      "save",
      "cancel install",
      "reading_unsaved",
    ]);
    desktop.retrySave();
    await desktop.close.request("quit");
    expect(desktop.events.at(-1)).toBe("stop API and quit");
  });

  it("retries the failed save inside the close decision", async () => {
    const desktop = setup();
    desktop.failSave();
    desktop.retrySave();
    await desktop.close.request("window");
    expect(desktop.events).toEqual([
      "save",
      "cancel install",
      "reading_unsaved",
      "save",
      "close window",
    ]);
  });

  it("does not flush or discard progress when the reviewer keeps an unsaved draft", async () => {
    const desktop = setup("dirty_draft");
    await desktop.close.request("window");
    expect(desktop.events).toEqual(["discard requested", "cancel install"]);
  });

  it("flushes reading progress separately after a draft discard is admitted", async () => {
    const desktop = setup("dirty_draft");
    desktop.discardDraft();
    await desktop.close.request("quit");
    expect(desktop.events).toEqual([
      "discard requested",
      "save",
      "stop API and quit",
    ]);
  });

  it("keeps a pending GitHub write alive without a save request", async () => {
    const desktop = setup("write_pending");
    await desktop.close.request("quit");
    expect(desktop.events).toEqual(["cancel install", "write_pending"]);
  });

  it("coalesces close gestures while the save is pending and checks newly admitted writes", async () => {
    const events: string[] = [];
    let resolveSave: ((saved: boolean) => void) | undefined;
    const saving = new Promise<boolean>((resolve) => {
      resolveSave = resolve;
    });
    let state: DesktopNavigationState = "clear";
    const close = new DesktopOrderlyClose({
      inspect: async () => ({
        state,
        draftRevision: 0,
        saved: false,
        rendererId: "renderer",
      }),
      holdInput: () => () => undefined,
      confirmDiscard: async () => false,
      flushReading: async () => ({
        saved: await saving,
        state,
        draftRevision: 0,
        rendererId: "renderer",
      }),
      async keepOpen(reason) {
        events.push(reason);
        return "stay";
      },
      cancelInstall() {
        events.push("cancel install");
      },
      complete(intent) {
        events.push(intent);
      },
    });
    const first = close.request("window");
    const second = close.request("quit");
    await Promise.resolve();
    expect(events).toEqual([]);
    state = "write_pending";
    resolveSave?.(true);
    await Promise.all([first, second]);
    expect(events).toEqual(["cancel install", "write_pending"]);
  });
});
