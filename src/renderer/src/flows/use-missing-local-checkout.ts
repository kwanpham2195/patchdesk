import { definedProps } from "#src/domain/defined-props";
import { useCallback, useEffect, useState } from "react";
import * as v from "valibot";

import { requestJson } from "#src/renderer/src/api-client";
import type { RelocatableRepository } from "#src/renderer/src/components/relocate-checkout-dialog";
import { localRepositoryListingSchema } from "#src/renderer/src/local-repositories";
import { storedBranchMismatchMessage } from "#src/renderer/src/local-review-reopen";
import {
  parseWorkbenchResponse,
  type WorkbenchResponse,
} from "#src/renderer/src/renderer-contracts";

/**
 * A shared local Review whose checkout folder is gone: read-only until it is
 * relocated (ADR 0058). A named worktree has no relocation: its moved folder
 * is a new source, opened with Open local checkout (ADR 0051).
 */
export type MissingLocalCheckoutControls =
  | {
      readonly kind: "repository";
      readonly repository: RelocatableRepository;
      readonly relocating: boolean;
      readonly startRelocate: () => void;
      readonly closeRelocate: () => void;
      /** Reads the Review again from its relocated checkout and drops the banner. */
      readonly finishRelocate: () => Promise<void>;
    }
  | { readonly kind: "worktree"; readonly path: string }
  /** A registration with no checkout in this workspace: only reconciliation fixes it, so no Relocate (ADR 0058). */
  | { readonly kind: "unresolved"; readonly displayName: string };

/** What the open local Review shows about a lost checkout folder. */
export type MissingLocalCheckout = {
  readonly controls: MissingLocalCheckoutControls | undefined;
  /** What Refresh and Apply need to know: the checkout cannot be read, and whether there is nothing to relocate. */
  readonly loss: {
    readonly checkoutMissing: boolean;
    readonly checkoutUnresolved: boolean;
  };
  /** Why the Review could not be read from a checkout that was just relocated. */
  readonly reloadNotice: string | undefined;
};

const parseListing = v.parser(localRepositoryListingSchema);
const parseFolderState = v.parser(v.object({ exists: v.boolean() }));

/**
 * Asks the main process whether the open local Review's checkout folder is
 * gone: its linked worktree's folder, else its repository's registered
 * checkout. Controls are undefined for a pull request Review, while the
 * answer is loading, and once the checkout is found.
 */
export function useMissingLocalCheckout({
  workbench,
  onWorkbenchReplace,
  onCheckoutRelocated,
}: {
  readonly workbench: WorkbenchResponse;
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly onCheckoutRelocated?: () => void;
}): MissingLocalCheckout {
  const { key } = workbench.session;
  // An upgraded registration keeps its GitHub key, so a Review stored under it matches by triple.
  const repositoryKey =
    "identityKey" in key
      ? key.identityKey.localRepositoryId
      : `${key.host}/${key.owner}/${key.repo}`;
  const worktree = "checkout" in key.source ? key.source.checkout : undefined;
  const isLocal = key.source.kind !== "pull_request";
  const profileId = key.profileId;
  const reviewId = workbench.review.id;
  const [missing, setMissing] = useState<
    | { readonly worktree: string }
    | { readonly unresolved: string }
    | { readonly repository: RelocatableRepository }
  >();
  const [relocating, setRelocating] = useState(false);
  // Tied to its Review, so a notice does not follow the reader to another one.
  const [reloadFailure, setReloadFailure] = useState<{
    readonly reviewId: string;
    readonly message: string;
  }>();
  const reloadNotice =
    reloadFailure?.reviewId === reviewId ? reloadFailure.message : undefined;
  const [checkedAgain, setCheckedAgain] = useState(0);

  useEffect(() => {
    if (!isLocal) return;
    let active = true;
    void (async () => {
      try {
        if (worktree !== undefined) {
          const folder = parseFolderState(
            await requestJson(
              `/v1/reviews/local-checkout-folder?${new URLSearchParams({ path: worktree })}`,
            ),
          );
          if (!active) return;
          if (!folder.exists) {
            setMissing({ worktree });
            return;
          }
        }
        const listing = parseListing(
          await requestJson(
            `/v1/local-repositories?${new URLSearchParams({ profileId })}`,
          ),
        );
        const repository = listing.find(
          (entry) =>
            entry.id === repositoryKey ||
            (entry.identityKey.kind === "github" &&
              `${entry.identityKey.host}/${entry.identityKey.owner}/${entry.identityKey.repo}` ===
                repositoryKey),
        );
        if (!active) return;
        if (repository?.state === "unresolved") {
          setMissing({ unresolved: repository.displayName });
          return;
        }
        setMissing(
          repository?.state === "missing"
            ? {
                repository: {
                  id: repository.id,
                  displayName: repository.displayName,
                  ...definedProps({ path: repository.configuredRoot }),
                },
              }
            : undefined,
        );
      } catch {
        // No answer leaves the Review as it is; Refresh reports a missing checkout itself.
        if (active) setMissing(undefined);
      }
    })();
    return () => {
      active = false;
    };
  }, [checkedAgain, isLocal, profileId, repositoryKey, reviewId, worktree]);

  const finishRelocate = useCallback(async (): Promise<void> => {
    setReloadFailure(undefined);
    try {
      const next = parseWorkbenchResponse(
        await requestJson("/v1/reviews/load", {
          method: "POST",
          body: { profileId, reviewId, recordOpen: true },
        }),
      );
      if (next !== undefined) onWorkbenchReplace(next);
    } catch (cause: unknown) {
      // The relocation is saved; the Review stays as captured until its branch is back.
      setReloadFailure({
        reviewId,
        message:
          storedBranchMismatchMessage(cause) ??
          "The checkout was relocated, but Patchdesk could not read this review from it. Press Refresh to try again.",
      });
    }
    onCheckoutRelocated?.();
    setRelocating(false);
    setCheckedAgain((count) => count + 1);
  }, [onCheckoutRelocated, onWorkbenchReplace, profileId, reviewId]);

  const controls = ((): MissingLocalCheckoutControls | undefined => {
    if (missing === undefined) return undefined;
    if ("worktree" in missing)
      return { kind: "worktree", path: missing.worktree };
    if ("unresolved" in missing)
      return { kind: "unresolved", displayName: missing.unresolved };
    return {
      kind: "repository",
      repository: missing.repository,
      relocating,
      startRelocate: () => setRelocating(true),
      closeRelocate: () => setRelocating(false),
      finishRelocate,
    };
  })();
  return {
    controls,
    loss: {
      checkoutMissing: controls !== undefined,
      checkoutUnresolved: controls?.kind === "unresolved",
    },
    reloadNotice,
  };
}
