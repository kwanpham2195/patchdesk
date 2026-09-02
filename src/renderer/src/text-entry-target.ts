/**
 * True when an event landed inside somewhere the user types. Document-level
 * shortcuts and the Pull requests paste handler both consult this so a real
 * keystroke or paste into a field is never taken over by the app.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable ||
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  );
}
