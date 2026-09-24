/**
 * True when an event landed inside somewhere the user types. Document-level
 * shortcuts consult this so a real keystroke into a field is never taken over
 * by the app.
 */
export function isTextEntryTarget(event: Event): boolean {
  // A window listener sees a shadow-root field (the Browse tree's search) retargeted to its host.
  const target = event.composedPath()[0] ?? event.target;
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable ||
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  );
}
