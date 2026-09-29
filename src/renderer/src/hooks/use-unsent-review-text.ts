import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
} from "react";

/**
 * Lets a text field in the open Review say it holds text that leaving the
 * Review would drop, so the workbench guards leaving (#643). Absent outside a
 * workbench, where no leave guard reads it.
 */
export const UnsentReviewTextContext = createContext<
  ((fieldId: string, unsent: boolean) => void) | undefined
>(undefined);

/** The workbench's side: whether any field holds unsent text, and the stable report function. */
export function useUnsentReviewTextFields() {
  const [fieldIds, setFieldIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const report = useCallback(
    (fieldId: string, unsent: boolean): void =>
      setFieldIds((current) => {
        if (current.has(fieldId) === unsent) return current;
        const next = new Set(current);
        if (unsent) next.add(fieldId);
        else next.delete(fieldId);
        return next;
      }),
    [],
  );
  return { holdsUnsentText: fieldIds.size > 0, report };
}

/** Reports `text` as unsent while it holds more than whitespace and the caller is mounted. */
export function useReportUnsentReviewText(text: string): void {
  const report = useContext(UnsentReviewTextContext);
  const fieldId = useId();
  const unsent = text.trim() !== "";
  useEffect(() => {
    if (report === undefined || !unsent) return;
    report(fieldId, true);
    return () => report(fieldId, false);
  }, [fieldId, report, unsent]);
}
