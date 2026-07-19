if (typeof HTMLElement !== "undefined") {
  if (HTMLElement.prototype.hasPointerCapture === undefined) {
    HTMLElement.prototype.hasPointerCapture = () => false;
  }
  if (HTMLElement.prototype.setPointerCapture === undefined) {
    HTMLElement.prototype.setPointerCapture = () => undefined;
  }
  if (HTMLElement.prototype.releasePointerCapture === undefined) {
    HTMLElement.prototype.releasePointerCapture = () => undefined;
  }
  if (HTMLElement.prototype.scrollIntoView === undefined) {
    HTMLElement.prototype.scrollIntoView = () => undefined;
  }
}

// jsdom has no PointerEvent; Base UI primitives re-dispatch clicks as
// PointerEvent on their hidden inputs, so polyfill it as a MouseEvent subclass.
if (typeof window !== "undefined" && window.PointerEvent === undefined) {
  class PointerEventPolyfill extends MouseEvent {
    public readonly pointerId: number;
    public readonly pointerType: string;
    public readonly isPrimary: boolean;

    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? "";
      this.isPrimary = params.isPrimary ?? false;
    }
  }
  window.PointerEvent =
    PointerEventPolyfill as unknown as typeof window.PointerEvent;
}

// jsdom lacks Element.getAnimations; Base UI scroll-area uses it to sync
// thumb visibility with running transitions.
if (
  typeof Element !== "undefined" &&
  Element.prototype.getAnimations === undefined
) {
  Element.prototype.getAnimations = () => [];
}

if (typeof ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserverStub implements ResizeObserver {
    disconnect(): void {}
    observe(): void {}
    unobserve(): void {}
  };
}
