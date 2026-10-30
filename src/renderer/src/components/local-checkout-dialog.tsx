import { definedProps } from "#src/domain/defined-props";
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
import {
  RelocateCheckoutDialog,
  type RelocatableRepository,
} from "./relocate-checkout-dialog";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
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

/** Keeps both ends of a long folder path: the volume or home and the last folders, which tell same-named checkouts apart. */
function shortenPathMiddle(path: string, limit = 56): string {
  if (path.length <= limit) return path;
  const tail = Math.ceil((limit - 1) * 0.65);
  return `${path.slice(0, limit - 1 - tail)}…${path.slice(-tail)}`;
}

export function LocalCheckoutDialog({
  profileId,
  pickOnOpen,
  onClose,
  onWorkspaceReload,
  onOpen,
  onRelocated,
}: {
  readonly profileId: string;
  readonly pickOnOpen: boolean;
  readonly onClose: () => void;
  readonly onWorkspaceReload: () => Promise<void>;
  readonly onOpen: InboxReviewOpeningControls["openLocalReview"];
  /** Told after a missing checkout is relocated, so the sidebar drops its hint. */
  readonly onRelocated: () => void;
}): React.JSX.Element {
  const path = `/v1/local-repositories?${new URLSearchParams({ profileId })}`;
  const [listingReads, setListingReads] = useState(0);
  const listing = useApiProbe(
    { path, restartKey: `${path}#${listingReads}` },
    parseLocalRepositoryListing,
  );
  const [selected, setSelected] = useState<{
    readonly id: string;
    readonly displayName: string;
    readonly profileId: string;
  }>();
  const [error, setError] = useState<string>();
  const [missingNotice, setMissingNotice] = useState<string>();
  const [relocating, setRelocating] = useState<RelocatableRepository>();
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
  if (relocating !== undefined)
    return (
      <RelocateCheckoutDialog
        repository={relocating}
        onRelocated={async () => {
          setRelocating(undefined);
          setListingReads((reads) => reads + 1);
          onRelocated();
          await onWorkspaceReload();
        }}
        onClose={() => setRelocating(undefined)}
      />
    );
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
        {missingNotice === undefined ? null : (
          <Alert variant="warning" role="status">
            <AlertDescription>{missingNotice}</AlertDescription>
          </Alert>
        )}
        {listing.kind === "error" ? (
          <p role="status">Registered repositories could not be read.</p>
        ) : null}
        {listing.kind === "loaded"
          ? listing.value.map((repository) => (
              <div key={repository.id} className="flex items-center gap-2">
                <Button
                  variant="outline"
                  className="h-auto min-w-0 flex-1 justify-start py-2"
                  disabled={pending || repository.state === "unresolved"}
                  onClick={() => {
                    if (repository.state === "missing") {
                      setMissingNotice(
                        `${repository.displayName}'s folder is missing${repository.configuredRoot === undefined ? "" : ` (${repository.configuredRoot})`}. Choose Relocate to point Patchdesk at its new location.`,
                      );
                      return;
                    }
                    setMissingNotice(undefined);
                    setError(undefined);
                    setSelected({ ...repository, profileId });
                  }}
                >
                  <span className="flex min-w-0 flex-col items-start gap-0.5">
                    <span className="flex max-w-full items-center gap-2">
                      <span className="truncate">{repository.displayName}</span>
                      {repository.state === "missing" ? (
                        <Badge variant="warning">Missing</Badge>
                      ) : null}
                      {repository.state === "unresolved" ? (
                        <Badge variant="outline">Unresolved</Badge>
                      ) : null}
                    </span>
                    {repository.configuredRoot === undefined ? null : (
                      <span
                        className="max-w-full truncate font-mono text-xs font-normal text-muted-foreground"
                        title={repository.configuredRoot}
                      >
                        {shortenPathMiddle(repository.configuredRoot)}
                      </span>
                    )}
                  </span>
                </Button>
                {repository.state === "missing" ? (
                  <Button
                    variant="secondary"
                    disabled={pending}
                    onClick={() => {
                      setError(undefined);
                      setMissingNotice(undefined);
                      setRelocating({
                        id: repository.id,
                        displayName: repository.displayName,
                        ...definedProps({ path: repository.configuredRoot }),
                      });
                    }}
                  >
                    Relocate…
                  </Button>
                ) : null}
              </div>
            ))
          : null}
        <Button disabled={pending} onClick={() => void choose()}>
          {pending ? "Opening…" : "Choose checkout"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
