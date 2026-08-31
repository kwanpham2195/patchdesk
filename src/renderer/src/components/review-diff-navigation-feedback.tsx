import type { ReviewDiffNavigationStatus } from "../review-diff-keyboard-nav";

/** Visible, absolute feedback for the latest successful or boundary attempt. */
export function ReviewDiffNavigationFeedback({
  status,
}: {
  readonly status: ReviewDiffNavigationStatus | undefined;
}): React.JSX.Element | null {
  if (status === undefined) return null;
  const target = status.state === "target" ? status : undefined;
  return (
    <p
      role="status"
      aria-label="Diff navigation status"
      data-review-diff-navigation-status
      data-navigation-kind={status.kind}
      data-navigation-state={status.state}
      data-navigation-position={target?.position}
      data-navigation-total={status.total}
      data-navigation-path={target?.path}
      data-navigation-line={
        target === undefined || target.kind === "file" ? undefined : target.line
      }
      className="pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-md border bg-card/95 px-3 py-2 text-sm shadow-lg backdrop-blur"
    >
      {status.message}
    </p>
  );
}
