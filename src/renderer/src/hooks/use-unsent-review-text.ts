import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useId,
  useRef,
  useState,
} from "react";

/**
 * Lets a text field in the open Review say it holds text that leaving the
 * Review would drop, so the workbench guards leaving (#643). Absent outside a
 * workbench, where no leave guard reads it.
 */
export const UnsentReviewTextContext = createContext<
  ((fieldId: string, text: string) => void) | undefined
>(undefined);

/** The workbench's side: whether any field holds unsent text, and the stable report function. */
export function useUnsentReviewTextFields() {
  const fields = useRef(new Map<string, string>());
  const [holdsUnsentText, setHoldsUnsentText] = useState(false);
  const report = useCallback((fieldId: string, text: string): void => {
    const value = text.trim() === "" ? undefined : text;
    if (fields.current.get(fieldId) === value) return;
    if (value === undefined) fields.current.delete(fieldId);
    else fields.current.set(fieldId, value);
    setHoldsUnsentText(fields.current.size > 0);
  }, []);
  const getDraftIdentity = useCallback(
    (): string =>
      fields.current.size === 0
        ? ""
        : JSON.stringify(
            [...fields.current].sort(([a], [b]) => a.localeCompare(b)),
          ),
    [],
  );
  return {
    holdsUnsentText,
    getDraftIdentity,
    report,
  };
}

/** Reports `text` as unsent while it holds more than whitespace and the caller is mounted. */
export function useReportUnsentReviewText(text: string): void {
  const report = useContext(UnsentReviewTextContext);
  const fieldId = useId();
  useLayoutEffect(() => {
    report?.(fieldId, text);
  }, [fieldId, report, text]);
  useLayoutEffect(() => () => report?.(fieldId, ""), [fieldId, report]);
}
