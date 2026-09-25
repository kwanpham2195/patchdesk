import { useEffect, useRef, useState } from "react";

import { Button } from "./ui/button";
import { InlineError } from "./ui/inline-error";

/**
 * Copies text the main process composes on demand. The label flips to
 * "Copied" only once the clipboard write resolves, and a failed load or
 * write says so under the button.
 */
export function CopyLoadedTextButton({
  label,
  load,
  failure,
}: {
  readonly label: string;
  readonly load: () => Promise<string>;
  readonly failure: string;
}): React.JSX.Element {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">(
    "idle",
  );
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(
    () => () => {
      clearTimeout(copiedTimer.current);
    },
    [],
  );
  return (
    <div className="flex flex-col gap-1">
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        disabled={state === "copying"}
        onClick={() => {
          setState("copying");
          load()
            .then((text) => navigator.clipboard.writeText(text))
            .then(() => {
              setState("copied");
              clearTimeout(copiedTimer.current);
              copiedTimer.current = setTimeout(() => setState("idle"), 1500);
            })
            .catch(() => setState("failed"));
        }}
      >
        {state === "copied" ? "Copied" : label}
      </Button>
      {state === "failed" ? <InlineError>{failure}</InlineError> : null}
    </div>
  );
}
