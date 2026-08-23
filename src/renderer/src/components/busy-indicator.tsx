import { Progress } from "@/components/ui/progress";
import { useBusy } from "@/hooks/use-busy";

/**
 * Slim indeterminate progress bar overlaid on the app titlebar while any
 * `runBusy` call is in flight. Overlaid rather than inserted as a layout
 * sibling: `.app-frame` sizes against `h-screen` assuming a fixed titlebar
 * height, so a sibling under the header would overflow the viewport.
 */
export function BusyIndicator(): React.JSX.Element | null {
  const { isBusy, label } = useBusy();
  if (!isBusy) return null;
  return (
    <Progress
      value={null}
      aria-label={label ?? "Loading"}
      className="absolute inset-x-0 bottom-0 h-0.5 w-full"
    />
  );
}
