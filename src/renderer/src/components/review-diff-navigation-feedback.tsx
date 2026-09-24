import type { ReviewDiffNavigationStatus } from "../review-diff-keyboard-nav";

/** Visible, absolute feedback for the latest successful or boundary attempt. */
export function ReviewDiffNavigationFeedback({
  status,
}: {
  readonly status: ReviewDiffNavigationStatus | undefined;
}): React.JSX.Element | null {
  if (status === undefined) return null;
  return (
    <p
      role="status"
      aria-label="Diff navigation status"
      data-review-diff-navigation-status
      data-navigation-kind={status.kind}
      data-navigation-state={status.state}
      data-navigation-position={
        "position" in status ? status.position : undefined
      }
      data-navigation-total={"total" in status ? status.total : undefined}
      data-navigation-path={"path" in status ? status.path : undefined}
      data-navigation-line={"line" in status ? status.line : undefined}
      className="pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-md border bg-card/95 px-3 py-2 text-sm shadow-lg backdrop-blur"
    >
      {status.message}
    </p>
  );
}
