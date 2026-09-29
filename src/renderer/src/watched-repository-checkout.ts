import { isApiErrorCode, requestJson, selectDirectory } from "./api-client";
import type { Repo } from "./renderer-models";

/**
 * Asks for a watched repository's checkout with the folder picker and saves
 * it for the workspace `profileId` names. Patchdesk never searches for
 * checkouts (#641), so this is the only way a repository gets one. Resolves
 * false when the picker is cancelled; rejects with the sentence to show when
 * the folder is refused or cannot be saved.
 */
export async function chooseRepositoryCheckout(
  profileId: string,
  repository: Repo,
): Promise<boolean> {
  try {
    const folder = await selectDirectory(repository.localPath);
    if (folder === undefined) return false;
    await requestJson("/v1/watchlist/checkout", {
      method: "PUT",
      body: {
        profileId,
        host: repository.host,
        owner: repository.owner,
        repo: repository.repo,
        localPath: folder,
      },
    });
    return true;
  } catch (cause: unknown) {
    throw new Error(checkoutChoiceFailure(cause, repository));
  }
}

function checkoutChoiceFailure(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejected request is `unknown` by construction; this maps it to the sentence shown beside the repository.
  cause: unknown,
  repository: Repo,
): string {
  if (isApiErrorCode(cause, "checkout_not_a_repository"))
    return "That folder is not inside a git checkout.";
  if (isApiErrorCode(cause, "checkout_origin_mismatch"))
    return `That checkout's origin is not ${repository.owner}/${repository.repo}.`;
  return cause instanceof Error
    ? cause.message
    : "Patchdesk could not save the checkout.";
}
