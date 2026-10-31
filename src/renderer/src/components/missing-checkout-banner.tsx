import { FolderSearch } from "lucide-react";

import type { MissingLocalCheckoutControls } from "#src/renderer/src/flows/use-missing-local-checkout";
import { RelocateCheckoutDialog } from "./relocate-checkout-dialog";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

/** Tells the reader a local Review is a stored snapshot because its checkout folder moved, and offers the fix. */
export function MissingCheckoutBanner({
  controls,
  reloadNotice,
}: {
  readonly controls: MissingLocalCheckoutControls | undefined;
  /** Why the Review could not be read from a checkout that was just relocated. */
  readonly reloadNotice: string | undefined;
}): React.JSX.Element | null {
  if (controls === undefined)
    return reloadNotice === undefined ? null : (
      <Alert variant="warning" role="status" className="mx-4 mt-2 w-auto">
        <AlertDescription>{reloadNotice}</AlertDescription>
      </Alert>
    );
  if (controls.kind === "worktree")
    return (
      <Alert
        variant="warning"
        className="mx-4 mt-2 w-auto"
        data-review-worktree-missing
      >
        <FolderSearch aria-hidden="true" />
        <AlertTitle>Worktree folder not found</AlertTitle>
        <AlertDescription>
          <span className="block font-mono text-xs break-all">
            {controls.path}
          </span>
          This review shows its last captured snapshot. Open the moved worktree
          with Open local checkout to start a new review.
        </AlertDescription>
      </Alert>
    );
  if (controls.kind === "unresolved")
    return (
      <Alert
        variant="warning"
        className="mx-4 mt-2 w-auto"
        data-review-checkout-unresolved
      >
        <FolderSearch aria-hidden="true" />
        <AlertTitle>No checkout for this repository</AlertTitle>
        <AlertDescription>
          Patchdesk shows the last captured snapshot of {controls.displayName}.
          This repository has no checkout in this workspace, so Refresh and
          Apply are off.
        </AlertDescription>
      </Alert>
    );
  const { repository } = controls;
  return (
    <>
      <Alert
        variant="warning"
        className="mx-4 mt-2 w-auto"
        data-review-checkout-missing
      >
        <FolderSearch aria-hidden="true" />
        <AlertTitle>Checkout folder not found</AlertTitle>
        <AlertDescription>
          {repository.path === undefined ? null : (
            <span className="block font-mono text-xs break-all">
              {repository.path}
            </span>
          )}
          Patchdesk shows the last captured snapshot of {repository.displayName}
          .
        </AlertDescription>
        <AlertAction>
          <Button size="sm" onClick={controls.startRelocate}>
            Relocate checkout…
          </Button>
        </AlertAction>
      </Alert>
      {controls.relocating ? (
        <RelocateCheckoutDialog
          repository={repository}
          onRelocated={controls.finishRelocate}
          onClose={controls.closeRelocate}
        />
      ) : null}
    </>
  );
}
