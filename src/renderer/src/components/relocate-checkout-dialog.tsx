import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import * as v from "valibot";

import {
  isApiErrorCode,
  requestJson,
  selectDirectory,
} from "#src/renderer/src/api-client";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { InlineError } from "./ui/inline-error";

/** The registered repository whose checkout folder was moved. */
export type RelocatableRepository = {
  readonly id: string;
  readonly displayName: string;
  /** The folder Patchdesk last knew, shown as the old path. */
  readonly path?: string;
};

const relocationSchema = v.object({
  checkout: v.string(),
  affectedReviews: v.array(
    v.object({ reviewId: v.string(), title: v.string() }),
  ),
});
const parseRelocation = v.parser(relocationSchema);

type Relocation = v.InferOutput<typeof relocationSchema>;

type Step =
  | { readonly kind: "picking" }
  | {
      readonly kind: "confirm";
      readonly folder: string;
      readonly relocation: Relocation;
    }
  | { readonly kind: "refused"; readonly message: string };

/**
 * Relocates a missing local checkout (ADR 0058): picks the moved folder, shows
 * the Reviews that keep their IDs, and saves only on confirmation. The main
 * process validates the folder and decides every refusal. Renders nothing
 * while the native picker is open.
 */
export function RelocateCheckoutDialog({
  repository,
  onRelocated,
  onClose,
}: {
  readonly repository: RelocatableRepository;
  /** Called once the new folder is saved. */
  readonly onRelocated: () => void | Promise<void>;
  readonly onClose: () => void;
}): React.JSX.Element | null {
  const [step, setStep] = useState<Step>({ kind: "picking" });
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const pickerStarted = useRef(false);

  const { id: repositoryId, path: oldPath, displayName } = repository;
  const pickFolder = useCallback(async (): Promise<void> => {
    setStep({ kind: "picking" });
    setSaveError(undefined);
    let folder: string | undefined;
    try {
      folder = await selectDirectory(oldPath);
    } catch {
      setStep({
        kind: "refused",
        message: "Patchdesk could not open the folder picker.",
      });
      return;
    }
    if (folder === undefined) {
      onClose();
      return;
    }
    try {
      const relocation = await requestRelocation(repositoryId, folder, false);
      setStep({ kind: "confirm", folder, relocation });
    } catch (cause: unknown) {
      setStep({
        kind: "refused",
        message: refusalMessage(cause, folder, displayName),
      });
    }
  }, [displayName, oldPath, onClose, repositoryId]);

  useEffect(() => {
    // The picker opens once, on mount; later picks come from Choose another folder.
    if (pickerStarted.current) return;
    pickerStarted.current = true;
    void pickFolder();
  }, [pickFolder]);

  if (step.kind === "picking") return null;

  if (step.kind === "refused")
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Can&rsquo;t use that folder</DialogTitle>
            <DialogDescription>{repository.displayName}</DialogDescription>
          </DialogHeader>
          <InlineError>{step.message}</InlineError>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void pickFolder()}>
              Choose another folder…
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );

  const { folder, relocation } = step;
  const reviews = relocation.affectedReviews;
  const confirm = async (): Promise<void> => {
    setSaving(true);
    setSaveError(undefined);
    try {
      await requestRelocation(repositoryId, folder, true);
      await onRelocated();
    } catch (cause: unknown) {
      setSaveError(refusalMessage(cause, folder, displayName));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Relocate {repository.displayName}?</DialogTitle>
          <DialogDescription>
            Patchdesk will read this repository from the new folder. Nothing in
            the folders changes.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          <PathLine label="Old folder" path={oldPath} />
          <ArrowDown
            className="ml-1 size-3.5 text-muted-foreground"
            aria-hidden="true"
          />
          <PathLine label="New folder" path={relocation.checkout} />
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">
            {reviews.length === 0
              ? "No saved reviews use this repository."
              : reviews.length === 1
                ? "This review keeps its notes and ID"
                : `These ${reviews.length} reviews keep their notes and IDs`}
          </p>
          {reviews.length === 0 ? null : (
            <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto text-sm text-muted-foreground">
              {reviews.map((review) => (
                <li key={review.reviewId} className="truncate">
                  {review.title}
                </li>
              ))}
            </ul>
          )}
        </div>
        {saveError === undefined ? null : (
          <InlineError>{saveError}</InlineError>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void confirm()}>
            {saving ? "Relocating…" : "Relocate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

async function requestRelocation(
  repositoryId: string,
  folder: string,
  confirm: boolean,
): Promise<Relocation> {
  return parseRelocation(
    await requestJson("/v1/local-repositories/relocate", {
      method: "POST",
      body: { repositoryId, cwd: folder, confirm },
    }),
  );
}

function PathLine({
  label,
  path,
}: {
  readonly label: string;
  readonly path: string | undefined;
}): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-xs break-all" title={path}>
        {path ?? "Unknown"}
      </span>
    </div>
  );
}

/** The sentence for a refused relocation; it names the folder and says what to do next. */
function refusalMessage(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejected request is `unknown` by construction; this maps it to one sentence.
  cause: unknown,
  folder: string,
  repositoryName: string,
): string {
  if (isApiErrorCode(cause, "checkout_not_a_repository"))
    return `${folder} is not a Git checkout. Choose the folder where you moved ${repositoryName}.`;
  if (isApiErrorCode(cause, "checkout_registered_elsewhere"))
    return `${folder} is already registered as a different repository in this workspace. Choose the folder where you moved ${repositoryName}.`;
  if (isApiErrorCode(cause, "repository_not_missing"))
    return `${repositoryName}'s folder exists again, so there is nothing to relocate. Close this and reopen the review.`;
  if (isApiErrorCode(cause, "repository_not_found"))
    return `${repositoryName} is no longer registered in this workspace.`;
  return `Patchdesk could not relocate ${repositoryName} to ${folder}. Try again, or choose another folder.`;
}
