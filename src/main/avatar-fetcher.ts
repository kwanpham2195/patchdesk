import type { AvatarFetcher } from "../services/avatar-sync-service";

/** GitHub avatar URLs accept `?s=<pixels>`; a small size keeps cached files tiny. */
const AVATAR_FETCH_SIZE_PX = 64;
/** Bounds one avatar download so a slow or hanging host can never stall a sync. */
const AVATAR_FETCH_TIMEOUT_MS = 3_000;

/**
 * Plain-HTTP avatar downloader for `AvatarSyncService`. Deliberately not the
 * gh-CLI-backed `GitHubAdapter`: avatar images are public, unauthenticated
 * URLs, so this uses the same bare `fetch` already used for the health
 * check above and the desktop bridge, bounded by an abort timeout.
 */
export function createAvatarFetcher(): AvatarFetcher {
  return async (avatarUrl) => {
    let target: string;
    try {
      const sized = new URL(avatarUrl);
      sized.searchParams.set("s", String(AVATAR_FETCH_SIZE_PX));
      target = sized.toString();
    } catch {
      return undefined;
    }
    const response = await fetch(target, {
      signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return { bytes: new Uint8Array(await response.arrayBuffer()) };
  };
}
