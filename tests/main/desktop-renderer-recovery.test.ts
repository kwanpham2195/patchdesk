import { describe, expect, it } from "vitest";
import { DesktopRendererRecovery } from "#src/main/desktop-renderer-recovery";
import type { DesktopNavigationState } from "#src/main/desktop-close-guard";

function setup(state: DesktopNavigationState = "clear") {
  const events: string[] = [];
  const window = {
    isDestroyed: () => false,
    reload() {
      events.push("reload");
    },
  };
  let current = window;
  let failed = true;
  let navigationState = state;
  let discard = async (): Promise<boolean> => false;
  const recovery = new DesktopRendererRecovery({
    current: () => current,
    isFailed: () => failed,
    navigationState: () => navigationState,
    show: async () => ({ response: 1 }),
    dialogs: {
      async confirmDiscard() {
        events.push("discard decision");
        return discard();
      },
      async keepOpen(reason) {
        events.push(reason);
        return "stay";
      },
    },
    cancelInstall() {
      events.push("cancel install");
    },
    requestQuit() {
      events.push("renderer admission");
    },
    approveQuit() {
      events.push("ordered shutdown");
    },
  });
  return {
    window,
    recovery,
    events,
    confirmWith(decision: () => Promise<boolean>) {
      discard = decision;
    },
    replaceWindow() {
      current = { ...window };
    },
    restoreRenderer() {
      failed = false;
    },
    startWrite() {
      navigationState = "write_pending";
    },
  };
}

describe("failed renderer recovery Quit", () => {
  it("reaches ordered shutdown without asking the crashed renderer for an acknowledgment", async () => {
    const desktop = setup();
    await desktop.recovery.offer(desktop.window, "Renderer process stopped");
    expect(desktop.events).toEqual(["ordered shutdown"]);
  });

  it("uses ordinary admission when the renderer is only unresponsive or has recovered", async () => {
    const desktop = setup();
    desktop.restoreRenderer();
    await desktop.recovery.offer(desktop.window, "Renderer stopped responding");
    expect(desktop.events).toEqual(["renderer admission"]);
  });

  it("preserves the pending GitHub write and cancels installation", async () => {
    const desktop = setup("write_pending");
    await desktop.recovery.offer(desktop.window, "Renderer process stopped");
    expect(desktop.events).toEqual(["cancel install", "write_pending"]);
  });

  it("keeps the app open when the reviewer refuses to discard unsaved text", async () => {
    const desktop = setup("dirty_draft");
    await desktop.recovery.offer(desktop.window, "Renderer process stopped");
    expect(desktop.events).toEqual(["discard decision", "cancel install"]);
  });

  it("admits shutdown after explicit draft discard for the still-failed renderer", async () => {
    const desktop = setup("dirty_draft");
    desktop.confirmWith(async () => true);
    await desktop.recovery.offer(desktop.window, "Renderer process stopped");
    expect(desktop.events).toEqual(["discard decision", "ordered shutdown"]);
  });

  it("does not apply the old window's decision to a replacement window", async () => {
    const desktop = setup("dirty_draft");
    desktop.confirmWith(async () => {
      desktop.replaceWindow();
      return true;
    });
    await desktop.recovery.offer(desktop.window, "Renderer process stopped");
    expect(desktop.events).toEqual(["discard decision"]);
  });

  it("requires fresh renderer admission if recovery occurs during the discard decision", async () => {
    const desktop = setup("dirty_draft");
    desktop.confirmWith(async () => {
      desktop.restoreRenderer();
      return true;
    });
    await desktop.recovery.offer(desktop.window, "Renderer process stopped");
    expect(desktop.events).toEqual(["discard decision", "renderer admission"]);
  });

  it("refuses a write that becomes pending during the draft decision", async () => {
    const desktop = setup("dirty_draft");
    desktop.confirmWith(async () => {
      desktop.startWrite();
      return true;
    });
    await desktop.recovery.offer(desktop.window, "Renderer process stopped");
    expect(desktop.events).toEqual([
      "discard decision",
      "cancel install",
      "write_pending",
    ]);
  });
});
