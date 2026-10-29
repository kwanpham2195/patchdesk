import { useCallback, useEffect, useRef, useState } from "react";
import * as v from "valibot";
import { requestJson, selectDirectory } from "#src/renderer/src/api-client";
import { localRepositoryListingSchema } from "#src/renderer/src/local-repositories";
import { localBranchesPath } from "#src/renderer/src/local-branches";
import { localCheckoutsPath } from "#src/renderer/src/local-checkouts";
import { useApiProbe } from "#src/renderer/src/hooks/use-api-probe";
import type { InboxReviewOpeningControls } from "#src/renderer/src/flows/use-inbox-review-opening";
import { localReviewOpenFailure } from "#src/renderer/src/flows/use-inbox-review-opening";
import { LocalReviewSourceDialog } from "./local-review-source-dialog";
import { Button } from "./ui/button";
import { InlineError } from "./ui/inline-error";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

const registeredCheckoutSchema = v.object({
  profile: v.object({ id: v.string() }),
  registration: v.object({ id: v.string(), displayName: v.string() }),
});
const parseLocalRepositoryListing = v.parser(localRepositoryListingSchema);

export function LocalCheckoutDialog({
  profileId,
  pickOnOpen,
  onClose,
  onWorkspaceReload,
  onOpen,
}: {
  readonly profileId: string;
  readonly pickOnOpen: boolean;
  readonly onClose: () => void;
  readonly onWorkspaceReload: () => Promise<void>;
  readonly onOpen: InboxReviewOpeningControls["openLocalReview"];
}): React.JSX.Element {
  const path = `/v1/local-repositories?${new URLSearchParams({ profileId })}`;
  const listing = useApiProbe(
    { path, restartKey: path },
    parseLocalRepositoryListing,
  );
  const [selected, setSelected] = useState<{
    readonly id: string;
    readonly displayName: string;
    readonly profileId: string;
  }>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const choose = useCallback(async () => {
    setPending(true);
    setError(undefined);
    try {
      const cwd = await selectDirectory();
      if (cwd === undefined) {
        onClose();
        return;
      }
      const registered = v.parse(
        registeredCheckoutSchema,
        await requestJson("/v1/local-repositories", {
          method: "POST",
          body: { cwd },
        }),
      );
      await onWorkspaceReload();
      setSelected({
        ...registered.registration,
        profileId: registered.profile.id,
      });
    } catch (cause: unknown) {
      setError(localReviewOpenFailure(cause));
    } finally {
      setPending(false);
    }
  }, [onClose, onWorkspaceReload]);
  const initialPickerStarted = useRef(false);
  useEffect(() => {
    if (!pickOnOpen || initialPickerStarted.current) return;
    initialPickerStarted.current = true;
    void choose();
  }, [pickOnOpen, choose]);
  if (selected !== undefined) {
    const target = { localRepositoryId: selected.id };
    return (
      <LocalReviewSourceDialog
        repositoryLabel={selected.displayName}
        checkoutsPath={localCheckoutsPath(selected.profileId, target)}
        branchesPath={(checkout) =>
          localBranchesPath(selected.profileId, target, checkout)
        }
        onOpen={(source) => onOpen(target, source)}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      />
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open local checkout</DialogTitle>
          <DialogDescription>
            Choose a registered repository or another Git checkout.
          </DialogDescription>
        </DialogHeader>
        {error === undefined ? null : <InlineError>{error}</InlineError>}
        {listing.kind === "error" ? (
          <p role="status">Registered repositories could not be read.</p>
        ) : null}
        {listing.kind === "loaded"
          ? listing.value.map((repository) => (
              <Button
                key={repository.id}
                variant="outline"
                disabled={pending || repository.state !== "resolved"}
                onClick={() => setSelected({ ...repository, profileId })}
              >
                {repository.displayName}
                {repository.state === "resolved"
                  ? ""
                  : ` · ${repository.state}`}
              </Button>
            ))
          : null}
        <Button disabled={pending} onClick={() => void choose()}>
          {pending ? "Opening…" : "Choose checkout"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
