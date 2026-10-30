import { FolderSearch } from "lucide-react";

import type { MissingLocalCheckoutControls } from "#src/renderer/src/flows/use-missing-local-checkout";
import { RelocateCheckoutDialog } from "./relocate-checkout-dialog";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

/** Tells the reader a local Review is a stored snapshot because its checkout folder moved, and offers the fix. */
export function MissingCheckoutBanner({
  controls,
}: {
  readonly controls: MissingLocalCheckoutControls;
}): React.JSX.Element {
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
