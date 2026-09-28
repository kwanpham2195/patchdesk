import type { ReactNode } from "react";

import { Button } from "./ui/button";

/** Shows the selected view or commit when its patch has no files. */
export function ReviewEmptyPatch({
  viewControl,
  commitHeader,
}: {
  readonly viewControl: ReactNode;
  readonly commitHeader?: {
    readonly title: string;
    readonly subtitle: ReactNode;
    readonly sha: string;
  };
}): React.JSX.Element {
  return (
    <>
      {viewControl === null ? null : (
        <div className="flex min-h-9 items-center border-b px-2 py-1">
          {viewControl}
        </div>
      )}
      {commitHeader === undefined ? null : (
        <header className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b bg-background/95 px-4 backdrop-blur">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{commitHeader.title}</p>
            <p className="text-xs text-muted-foreground">
              {commitHeader.subtitle}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() =>
              void navigator.clipboard?.writeText(commitHeader.sha)
            }
          >
            Copy commit SHA
          </Button>
        </header>
      )}
      <p role="status" className="p-6 text-sm text-muted-foreground">
        {commitHeader === undefined
          ? "No changed files in this view."
          : "This commit changes no files."}
      </p>
    </>
  );
}
