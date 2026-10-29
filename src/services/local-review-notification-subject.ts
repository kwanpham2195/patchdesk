import type { ProfileStore } from "#src/adapters/storage/profile-store";
import type { LocalReviewNotificationSubject } from "./desktop-notifier";
import type { Review } from "#src/domain/review";
import {
  reviewSourceTitle,
  type LocalReviewSource,
} from "#src/domain/review-source";

/**
 * How a desktop notification names a local Review (ADR 0052, #496): its
 * source title with the checkout folder, which is the configured checkout's
 * when the source names none, and the profile when more than one exists.
 */
export async function localReviewNotificationSubject(
  profiles: Pick<ProfileStore, "list">,
  review: Review<LocalReviewSource>,
): Promise<LocalReviewNotificationSubject> {
  const listed = await profiles.list();
  const saved = listed._tag === "ok" ? listed.value : [];
  const { profileId, identityKey, source } = review.identity;
  const profile = saved.find((candidate) => candidate.id === profileId);
  const localPath = profile?.repos.find(
    (entry) =>
      identityKey.kind === "github" &&
      entry.host === identityKey.host &&
      entry.owner === identityKey.owner &&
      entry.repo === identityKey.repo,
  )?.localPath;
  const localTitle = reviewSourceTitle({
    ...source,
    checkout: source.checkout ?? localPath,
  });
  return profile === undefined || saved.length < 2
    ? { localTitle }
    : { localTitle, profileLabel: profile.label };
}
