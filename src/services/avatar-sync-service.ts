import * as v from "valibot";

import {
  hasAvatar,
  hashAvatarUrl,
  writeAvatar,
} from "../adapters/storage/avatar-cache-store";
import type { PatchdeskPaths } from "../adapters/storage/patchdesk-paths";
import type { ReviewRemoteSnapshot } from "../adapters/storage/review-remote-store";
import type { WorkspaceProfileId } from "../domain/ids";
import type { AppLogService } from "./app-log-service";

/**
 * Shape of the error Node/undici nests one level below a `fetch` failure.
 * A failed undici `fetch` always throws with the generic message
 * `"fetch failed"`; the actual reason (DNS failure, TLS error, connection
 * refused, ...) lives in `cause.cause`, usually alongside a `.code` like
 * `ENOTFOUND` or `ECONNREFUSED`.
 */
const nestedFetchCauseSchema = v.object({
  message: v.string(),
  code: v.optional(v.string()),
});

/**
 * Narrows an unknown thrown value's `cause.cause` into a loggable shape, or
 * `undefined` when it isn't the errno-like error Node/undici usually nests
 * there. `Error.cause` is typed `unknown`, so this parses rather than casts.
 */
function describeNestedCause(
  cause: unknown,
):
  | { readonly message: string; readonly code?: string | undefined }
  | undefined {
  if (!(cause instanceof Error)) return undefined;
  const parsed = v.safeParse(nestedFetchCauseSchema, cause.cause);
  return parsed.success ? parsed.output : undefined;
}

/**
 * Downloads one avatar's bytes, or resolves `undefined` for any failure
 * (network error, non-2xx response, timeout). Never rejects: `AvatarSyncService`
 * treats a fetcher that throws the same as one that resolves `undefined`, but
 * a well-behaved implementation should prefer the latter.
 */
export type AvatarFetcher = (
  avatarUrl: string,
) => Promise<{ readonly bytes: Uint8Array } | undefined>;

export type AvatarSyncDependencies = {
  readonly paths: PatchdeskPaths;
  readonly fetchAvatar: AvatarFetcher;
  /** Best-effort diagnostic stream; a missing or slow avatar is never worth surfacing to the user. */
  readonly log?: Pick<AppLogService, "write">;
};

/**
 * The optional, best-effort avatar dependency shape `AssigneeService.list`
 * and `ReviewerService.list` each take, mirroring `ReviewRefreshService
 * .dependencies.avatars` (`Pick<AvatarSyncService, "syncCommentAuthors">`)
 * but bundled with the `PatchdeskPaths` those two reads also need to resolve
 * a warmed avatar back into a `data:` URI via `resolveAvatarDataUris`. Absent
 * entirely when no live `AvatarSyncService`/`PatchdeskPaths` pair was wired
 * (e.g. a test that never exercises avatar behaviour) — in that case both
 * services skip warming and resolution outright, and every row simply has no
 * `avatarDataUri`, falling back to the initials badge.
 */
export type AvatarRailDependencies = {
  readonly paths: PatchdeskPaths;
  readonly sync: Pick<AvatarSyncService, "warmAvatarUrls">;
};

/**
 * Per-sync cap on distinct avatars fetched. A PR conversation realistically
 * involves a handful of participants; this bounds the pathological case
 * (a thread with many distinct authors) so one sync can't fan out into an
 * unbounded number of requests. Uncapped avatars are simply left unfetched
 * until a later sync revisits them.
 */
const MAX_AVATARS_PER_SYNC = 24;

/**
 * Warms the shared per-profile avatar cache from one refreshed snapshot.
 * Every step is best-effort: an avatar is decorative, so nothing here may
 * fail a sync, and `syncCommentAuthors` itself never throws or rejects.
 */
export class AvatarSyncService {
  constructor(private readonly dependencies: AvatarSyncDependencies) {}

  async syncCommentAuthors(input: {
    readonly profileId: WorkspaceProfileId;
    readonly snapshot: ReviewRemoteSnapshot;
  }): Promise<void> {
    await this.syncUrls(input.profileId, collectAvatarUrls(input.snapshot));
  }

  /**
   * Warms the cache for an explicit, already-priority-ordered set of avatar
   * URLs — the people a pull-request-metadata read (`AssigneeService.list`,
   * `ReviewerService.list`) is about to render, rather than the comment
   * authors `syncCommentAuthors` walks out of a snapshot. Same
   * `MAX_AVATARS_PER_SYNC` bound and never-throws contract: callers should
   * put their most important people first in `avatarUrls`, since anything
   * past the cap is left unfetched until a later sync revisits it.
   */
  async warmAvatarUrls(input: {
    readonly profileId: WorkspaceProfileId;
    readonly avatarUrls: ReadonlyArray<string>;
  }): Promise<void> {
    await this.syncUrls(input.profileId, input.avatarUrls);
  }

  /**
   * Shared fan-out for both public entry points: dedupes (first occurrence
   * wins, preserving whatever priority order the caller already applied),
   * caps at `MAX_AVATARS_PER_SYNC`, and syncs every surviving URL
   * concurrently and best-effort.
   */
  private async syncUrls(
    profileId: WorkspaceProfileId,
    avatarUrls: ReadonlyArray<string>,
  ): Promise<void> {
    const urls = [...new Set(avatarUrls)].slice(0, MAX_AVATARS_PER_SYNC);
    if (urls.length === 0) return;
    await Promise.allSettled(urls.map((url) => this.syncOne(profileId, url)));
  }

  private async syncOne(
    profileId: WorkspaceProfileId,
    avatarUrl: string,
  ): Promise<void> {
    try {
      const avatarHash = hashAvatarUrl(avatarUrl);
      if (await hasAvatar(this.dependencies.paths, profileId, avatarHash))
        return;
      const fetched = await this.dependencies.fetchAvatar(avatarUrl);
      if (fetched === undefined) return;
      const written = await writeAvatar(
        this.dependencies.paths,
        profileId,
        avatarHash,
        fetched.bytes,
      );
      if (written._tag === "err") {
        this.dependencies.log?.write({
          process: "main",
          level: "debug",
          topic: "avatar-sync",
          message: "avatar cache write failed; skipped, non-fatal",
          profileId,
          meta: { reason: written.error.reason },
        });
      }
    } catch (cause) {
      // Offline, DNS failure, timeout, or anything else: silently skip. A
      // decorative avatar must never surface an error to the user. The
      // top-level message is near-useless for undici `fetch` failures (it's
      // always "fetch failed"), so also surface the nested cause when present.
      const nestedCause = describeNestedCause(cause);
      const causeMessage =
        cause instanceof Error ? cause.message : String(cause);
      const meta =
        nestedCause === undefined
          ? { cause: causeMessage }
          : nestedCause.code === undefined
            ? { cause: causeMessage, causeOfCause: nestedCause.message }
            : {
                cause: causeMessage,
                causeOfCause: nestedCause.message,
                causeOfCauseCode: nestedCause.code,
              };
      this.dependencies.log?.write({
        process: "main",
        level: "debug",
        topic: "avatar-sync",
        message: "avatar fetch failed; skipped, non-fatal",
        profileId,
        meta,
      });
    }
  }
}

/**
 * Every comment-shaped record in a snapshot carries `GitHubComment`'s
 * optional `authorAvatarUrl`; this walks each place one can appear.
 */
function collectAvatarUrls(
  snapshot: ReviewRemoteSnapshot,
): ReadonlyArray<string> {
  const urls = new Set<string>();
  const addFrom = (
    comments: ReadonlyArray<{ readonly authorAvatarUrl?: string }>,
  ) => {
    for (const comment of comments) {
      if (comment.authorAvatarUrl !== undefined)
        urls.add(comment.authorAvatarUrl);
    }
  };
  for (const thread of snapshot.comments.threads) addFrom(thread.comments);
  for (const entry of snapshot.conversation.entries) {
    if (entry._tag === "IssueComment") addFrom([entry.comment]);
    if (entry._tag === "GeneralThread") addFrom(entry.thread.comments);
  }
  if (snapshot.conversation.inline !== undefined) {
    for (const thread of snapshot.conversation.inline.threads)
      addFrom(thread.comments);
  }
  if (snapshot.publishedFeedback !== undefined)
    addFrom(snapshot.publishedFeedback.comments);
  return [...urls];
}
