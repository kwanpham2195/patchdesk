import { useCallback, useState } from "react";

import type { RepositoryIdentity } from "../../../domain/repository-identity";
import { requestJson } from "../api-client";
import {
  localBranchesPath,
  parseLocalBranches,
  sharedReviewSource,
} from "../local-branches";
import {
  localReviewOpenFailure,
  type InboxReviewOpeningControls,
} from "./use-inbox-review-opening";

/** A repository checkout a sidebar row opens; `checkout` names a linked worktree (#489). */
export type LocalCheckoutTarget = RepositoryIdentity & {
  readonly checkout?: string;
};

/** What a sidebar local row's click drives: the open, and the dialog it may show instead. */
type LocalRowOpenControls = {
  /** A refused open calls `leave` before reporting; a parked open has already left. */
  readonly openRow: (
    target: LocalCheckoutTarget,
    leave: () => void,
  ) => Promise<void>;
  /** The checkout the dialog is open for, while it is open. */
  readonly dialogTarget: LocalCheckoutTarget | undefined;
  readonly closeDialog: () => void;
};

/**
 * A sidebar local row's click (#479, #555). It reads the branch the checkout
 * is on now and opens that branch's one shared Review; with none, or with
 * reviews against several bases, it opens the Local review dialog for the
 * checkout instead, which preselects the inferred base and lists the others.
 */
export function useLocalRowOpen({
  profileId,
  openLocalReview,
  reportOpenError,
}: {
  readonly profileId: string | undefined;
  readonly openLocalReview: InboxReviewOpeningControls["openLocalReview"];
  readonly reportOpenError: InboxReviewOpeningControls["reportOpenError"];
}): LocalRowOpenControls {
  const [dialogTarget, setDialogTarget] = useState<LocalCheckoutTarget>();
  const openRow = useCallback(
    async (target: LocalCheckoutTarget, leave: () => void): Promise<void> => {
      if (profileId === undefined) return;
      const refuse = (message: string): void => {
        leave();
        reportOpenError(message);
      };
      let listing;
      try {
        listing = parseLocalBranches(
          await requestJson(
            localBranchesPath(profileId, target, target.checkout),
          ),
        );
      } catch (cause: unknown) {
        refuse(localReviewOpenFailure(cause));
        return;
      }
      if (listing === undefined) {
        refuse("Patchdesk could not read the checkout's branches.");
        return;
      }
      const [only, ...others] = listing.reviewedBases;
      if (only === undefined || others.length > 0) {
        setDialogTarget(target);
        return;
      }
      try {
        await openLocalReview(
          target,
          sharedReviewSource(only, listing.head, target.checkout),
        );
      } catch (cause: unknown) {
        // `openLocalReview` rejects with the sentence to show.
        refuse(
          cause instanceof Error ? cause.message : "Could not open review.",
        );
      }
    },
    [openLocalReview, profileId, reportOpenError],
  );
  const closeDialog = useCallback(() => setDialogTarget(undefined), []);
  return { openRow, dialogTarget, closeDialog };
}
