import { useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#src/renderer/src/components/ui/alert-dialog";
import { Button } from "#src/renderer/src/components/ui/button";
import { InlineError } from "#src/renderer/src/components/ui/inline-error";
import { Spinner } from "#src/renderer/src/components/ui/spinner";
import { requestJson } from "#src/renderer/src/api-client";

/**
 * Settings > Workspace: stop using GitHub in this workspace. Only the
 * connection is dropped (ADR 0058), which the confirmation says in the terms
 * a maintainer would ask about: what stays, and what stops.
 */
export function DisconnectGitHubRow({
  profileId,
  onDisconnected,
}: {
  readonly profileId: string;
  readonly onDisconnected: () => Promise<void>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();

  const disconnect = async (): Promise<void> => {
    setPending(true);
    setFailure(undefined);
    try {
      await requestJson("/v1/workspace/connection/disconnect", {
        method: "POST",
        body: { profileId },
      });
      setOpen(false);
      await onDisconnected();
    } catch (cause: unknown) {
      setFailure(
        cause instanceof Error
          ? cause.message
          : "Patchdesk could not disconnect GitHub.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-sm text-muted-foreground">
          Stop using GitHub in this workspace. Local reviews and saved pull
          requests are kept.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setFailure(undefined);
            setOpen(true);
          }}
        >
          Disconnect GitHub
        </Button>
      </div>
      <AlertDialog open={open} onOpenChange={pending ? undefined : setOpen}>
        <AlertDialogContent className="data-[size=default]:sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect GitHub?</AlertDialogTitle>
            <AlertDialogDescription>
              Patchdesk stops reading GitHub for this workspace and checking
              watched pull requests.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            <li>
              Kept: local repositories, local Reviews and their notes, watched
              repositories, saved pull request Reviews.
            </li>
            <li>
              Unfinished GitHub writes stay locked until you connect GitHub
              again.
            </li>
          </ul>
          {failure === undefined ? null : <InlineError>{failure}</InlineError>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => void disconnect()}
            >
              {pending ? (
                <>
                  <Spinner data-icon="inline-start" />
                  Disconnecting…
                </>
              ) : (
                "Disconnect"
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
