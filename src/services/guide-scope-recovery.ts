import type { GuideScope } from "#src/adapters/storage/guide-preparation-store";
import { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import { InsightStore } from "#src/adapters/storage/insight-store";
import type { IsoTimestamp } from "#src/domain/ids";
import type { Result } from "#src/domain/result";
import type { InsightResourceBundle } from "./insight-resource-bundle";
import type { InsightSlotFailure } from "./insight-slot-records";
import { InsightSlotAuthority } from "./insight-slot-authority";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";

/** Settles an unowned Guide diagnostic run only inside its registered scope, never the source Review. */
export async function recoverGuideScope(
  scope: GuideScope,
  resources: InsightResourceBundle,
  operations: ReviewOperationCoordinator,
  now: () => IsoTimestamp,
): Promise<Result<void, InsightSlotFailure>> {
  const destination = PatchdeskPaths.fromEnvironment({
    PATCHDESK_CONFIG_DIRECTORY: scope.path,
    PATCHDESK_DATA_DIRECTORY: scope.path,
    PATCHDESK_CACHE_DIRECTORY: scope.path,
  });
  return new InsightSlotAuthority(
    destination,
    resources.authorityReader,
    new InsightStore(destination, resources.authorityReader),
    operations,
    now,
  ).recover(
    { profileId: scope.profileId, reviewId: scope.reviewId, type: "guide" },
    resources.ownership.forScope(destination.dataDirectory()),
  );
}
