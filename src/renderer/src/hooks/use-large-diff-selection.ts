import { useEffect, useState } from "react";

/**
 * The selected path the diff renders. For extraordinarily large patches a
 * burst of navigator changes settles for 150 ms before Pierre performs its
 * expensive virtual-file replacement; normal reviews switch at once.
 */
export function useLargeDiffSelection(
  selectedPath: string | undefined,
  deferReplacement: boolean,
): string | undefined {
  const [renderedPath, setRenderedPath] = useState(selectedPath);
  useEffect(() => {
    if (!deferReplacement) return;
    if (selectedPath === undefined) {
      setRenderedPath(selectedPath);
      return;
    }
    const timer = window.setTimeout(() => setRenderedPath(selectedPath), 150);
    return () => window.clearTimeout(timer);
  }, [deferReplacement, selectedPath]);
  // Routing a normal review through the state above would render the surface
  // once more with the outgoing path, which flips the navigator's highlight.
  return deferReplacement ? renderedPath : selectedPath;
}
