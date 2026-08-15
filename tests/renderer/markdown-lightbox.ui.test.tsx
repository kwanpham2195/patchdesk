// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarkdownLightbox } from "../../src/renderer/src/components/markdown-lightbox";

const originalShowModalDescriptor = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "showModal",
);
const originalCloseDescriptor = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "close",
);

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement): void {
      this.removeAttribute("open");
    },
  });
});

afterEach(() => {
  cleanup();
  restoreDialogMethod("showModal", originalShowModalDescriptor);
  restoreDialogMethod("close", originalCloseDescriptor);
});

function restoreDialogMethod(
  method: "showModal" | "close",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(HTMLDialogElement.prototype, method);
    return;
  }
  Object.defineProperty(HTMLDialogElement.prototype, method, descriptor);
}

describe("MarkdownLightbox", () => {
  it("makes zoomed content scrollable and pans it by dragging", async () => {
    const user = userEvent.setup();
    render(
      <MarkdownLightbox open onClose={vi.fn()}>
        <div className="size-24" />
      </MarkdownLightbox>,
    );

    const viewport = screen.getByRole("region", { name: "Zoomable content" });
    await user.click(screen.getByRole("button", { name: "Zoom in" }));

    expect(viewport.className).toContain("overflow-auto");
    expect(viewport.className).toContain("cursor-grab");
    expect((viewport.firstElementChild as HTMLElement).style.zoom).toBe("1.25");

    viewport.scrollLeft = 120;
    viewport.scrollTop = 200;
    fireEvent.pointerDown(viewport, {
      pointerId: 1,
      clientX: 300,
      clientY: 400,
    });
    fireEvent.pointerMove(viewport, {
      pointerId: 1,
      clientX: 250,
      clientY: 360,
    });

    expect(viewport.scrollLeft).toBe(170);
    expect(viewport.scrollTop).toBe(240);
  });

  it("opens as a native modal and delegates cancel to onClose", () => {
    const onClose = vi.fn();
    render(
      <MarkdownLightbox open onClose={onClose}>
        <div className="size-24" />
      </MarkdownLightbox>,
    );

    const dialog = screen.getByRole("dialog", { name: "Image viewer" });
    expect(dialog.tagName).toBe("DIALOG");
    expect((dialog as HTMLDialogElement).open).toBe(true);
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes through the semantic backdrop button", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <MarkdownLightbox open onClose={onClose}>
        <div className="size-24" />
      </MarkdownLightbox>,
    );

    const backdrop = screen.getByRole("button", {
      name: "Close image viewer backdrop",
    });
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("resets zoom and fit state after close and reopen", async () => {
    const user = userEvent.setup();
    const view = render(
      <MarkdownLightbox open onClose={vi.fn()}>
        <div className="size-24" />
      </MarkdownLightbox>,
    );

    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("125%")).toBeTruthy();

    view.rerender(
      <MarkdownLightbox open={false} onClose={vi.fn()}>
        <div className="size-24" />
      </MarkdownLightbox>,
    );
    view.rerender(
      <MarkdownLightbox open onClose={vi.fn()}>
        <div className="size-24" />
      </MarkdownLightbox>,
    );

    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actual size" })).toBeTruthy();
  });
});
