if (globalThis.HTMLElement !== undefined) {
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
  // Pierre's CodeView imperatively scrolls its own container element when a
  // selection resolves; jsdom has no scroll implementation to run.
  if (HTMLElement.prototype.scrollTo === undefined) {
    HTMLElement.prototype.scrollTo = () => undefined;
  }
}

// jsdom has no PointerEvent; Base UI primitives re-dispatch clicks as
// PointerEvent on their hidden inputs, so polyfill it as a MouseEvent subclass.
if (globalThis.window !== undefined && window.PointerEvent === undefined) {
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
  // SAFETY: PointerEventPolyfill implements only the pointer fields Base UI's
  // re-dispatched events read (pointerId, pointerType, isPrimary), not
  // PointerEvent's full interface (pressure, tiltX, twist, ...). jsdom has no
  // native PointerEvent of its own to construct or compare against, so no
  // caller here ever reads the members this polyfill omits.
  window.PointerEvent = PointerEventPolyfill as typeof window.PointerEvent;
}

// jsdom lacks Element.getAnimations; Base UI scroll-area uses it to sync
// thumb visibility with running transitions.
if (
  globalThis.Element !== undefined &&
  Element.prototype.getAnimations === undefined
) {
  Element.prototype.getAnimations = () => [];
}

if (globalThis.ResizeObserver === undefined) {
  globalThis.ResizeObserver = class ResizeObserverStub implements ResizeObserver {
    disconnect(): void {}
    observe(): void {}
    unobserve(): void {}
  };
}
