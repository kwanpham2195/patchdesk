import { definedProps } from "#src/domain/defined-props";
import { useCallback, useEffect, useState } from "react";
import * as v from "valibot";

import { requestJson } from "#src/renderer/src/api-client";
import type { RelocatableRepository } from "#src/renderer/src/components/relocate-checkout-dialog";
import { localRepositoryListingSchema } from "#src/renderer/src/local-repositories";
import {
  parseWorkbenchResponse,
  type WorkbenchResponse,
} from "#src/renderer/src/renderer-contracts";

/** A shared local Review whose registered checkout folder is gone: read-only until it is relocated (ADR 0058). */
export type MissingLocalCheckoutControls = {
  readonly repository: RelocatableRepository;
  readonly relocating: boolean;
  readonly startRelocate: () => void;
  readonly closeRelocate: () => void;
  /** Reads the Review again from its relocated checkout and drops the banner. */
  readonly finishRelocate: () => Promise<void>;
};

const parseListing = v.parser(localRepositoryListingSchema);

/**
 * Asks the main process whether the open local Review's repository has lost
 * its checkout folder. Undefined for a pull request Review, while the answer
 * is loading, and once the checkout is found.
 */
export function useMissingLocalCheckout({
  workbench,
  onWorkbenchReplace,
  onCheckoutRelocated,
}: {
  readonly workbench: WorkbenchResponse;
  readonly onWorkbenchReplace: (workbench: WorkbenchResponse) => void;
  readonly onCheckoutRelocated?: () => void;
}): MissingLocalCheckoutControls | undefined {
  const { key } = workbench.session;
  const repositoryId =
    "identityKey" in key ? key.identityKey.localRepositoryId : undefined;
  const profileId = key.profileId;
  const reviewId = workbench.review.id;
  const [missing, setMissing] = useState<RelocatableRepository>();
  const [relocating, setRelocating] = useState(false);
  const [checkedAgain, setCheckedAgain] = useState(0);

  useEffect(() => {
    if (repositoryId === undefined) return;
    let active = true;
    void (async () => {
      try {
        const listing = parseListing(
          await requestJson(
            `/v1/local-repositories?${new URLSearchParams({ profileId })}`,
          ),
        );
        const repository = listing.find((entry) => entry.id === repositoryId);
        if (!active) return;
        setMissing(
          repository?.state === "missing"
            ? {
                id: repository.id,
                displayName: repository.displayName,
                ...definedProps({ path: repository.configuredRoot }),
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
  }, [checkedAgain, profileId, repositoryId, reviewId]);

  const finishRelocate = useCallback(async (): Promise<void> => {
    try {
      const next = parseWorkbenchResponse(
        await requestJson("/v1/reviews/load", {
          method: "POST",
          body: { profileId, reviewId, recordOpen: true },
        }),
      );
      if (next !== undefined) onWorkbenchReplace(next);
    } catch {
      // The relocation is saved; the next Refresh names whatever stops the reload.
    }
    onCheckoutRelocated?.();
    setRelocating(false);
    setCheckedAgain((count) => count + 1);
  }, [onCheckoutRelocated, onWorkbenchReplace, profileId, reviewId]);

  if (missing === undefined) return undefined;
  return {
    repository: missing,
    relocating,
    startRelocate: () => setRelocating(true),
    closeRelocate: () => setRelocating(false),
    finishRelocate,
  };
}
