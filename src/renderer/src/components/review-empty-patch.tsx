import type { ReactNode } from "react";

/** Keeps the local view switch available when the selected patch has no files. */
export function ReviewEmptyPatch({
  viewControl,
}: {
  readonly viewControl: ReactNode;
}): React.JSX.Element {
  return (
    <>
      {viewControl === null ? null : (
        <div className="flex min-h-9 items-center border-b px-2 py-1">
          {viewControl}
        </div>
      )}
      <p role="status" className="p-6 text-sm text-muted-foreground">
        No changed files in this view.
      </p>
    </>
  );
}
