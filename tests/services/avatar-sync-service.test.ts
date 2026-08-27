import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasAvatar,
  hashAvatarUrl,
} from "../../src/adapters/storage/avatar-cache-store";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import type { ReviewRemoteSnapshot } from "../../src/adapters/storage/review-remote-store";
import { parseWorkspaceProfileId } from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";
import { AvatarSyncService } from "../../src/services/avatar-sync-service";

// The avatar fan-out cap is written out here rather than imported from the
// service, so this test pins the cap instead of restating whatever the
// implementation happens to hold.
const MAX_AVATARS_PER_SYNC = 24;

const must = <T>(result: Result<T, unknown>): T =>
  result._tag === "ok"
    ? result.value
    : (() => {
        throw new Error("fixture");
      })();
const profileId = must(parseWorkspaceProfileId("cfw"));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function paths(): Promise<PatchdeskPaths> {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-avatar-sync-"));
  roots.push(root);
  return PatchdeskPaths.forTest(root);
}

const bytes = new Uint8Array([1, 2, 3, 4]);

function snapshotWithCommentAvatars(
  urls: ReadonlyArray<string>,
): ReviewRemoteSnapshot {
  return {
    schemaVersion: 1,
    // SAFETY: this fixture snapshot's pullRequest is never read by
    // AvatarSyncService; only comments/conversation/publishedFeedback are.
    pullRequest: {} as never,
    comments: {
      threads: [
        {
          // SAFETY: thread id/state are not read by AvatarSyncService.
          id: "thread-1" as never,
          state: "open",
          comments: urls.map((authorAvatarUrl, index) => ({
            id: `comment-${index}`,
            author: `author-${index}`,
            authorAvatarUrl,
            body: "hi",
            // SAFETY: createdAt is not read by AvatarSyncService.
            createdAt: "2026-08-01T00:00:00.000Z" as never,
          })),
        },
      ],
    },
    commits: [],
    checks: { overall: "passing", checks: [] },
    conversation: { prDescription: "", entries: [] },
  };
}

describe("AvatarSyncService", () => {
  it("downloads and caches an avatar it has not seen before", async () => {
    const store = await paths();
    const fetchAvatar = vi.fn(async () => ({ bytes }));
    const service = new AvatarSyncService({ paths: store, fetchAvatar });
    const url = "https://avatars.githubusercontent.com/u/1?v=4";
    await service.syncCommentAuthors({
      profileId,
      snapshot: snapshotWithCommentAvatars([url]),
    });
    expect(fetchAvatar).toHaveBeenCalledTimes(1);
    expect(fetchAvatar).toHaveBeenCalledWith(url);
    expect(await hasAvatar(store, profileId, hashAvatarUrl(url))).toBe(true);
  });

  it("does not refetch an avatar already cached", async () => {
    const store = await paths();
    const fetchAvatar = vi.fn(async () => ({ bytes }));
    const service = new AvatarSyncService({ paths: store, fetchAvatar });
    const url = "https://avatars.githubusercontent.com/u/2?v=4";
    const snapshot = snapshotWithCommentAvatars([url]);

    await service.syncCommentAuthors({ profileId, snapshot });
    await service.syncCommentAuthors({ profileId, snapshot });

    expect(fetchAvatar).toHaveBeenCalledTimes(1);
  });

  it("leaves the sync successful when a fetch fails (non-fatal, most important constraint)", async () => {
    const store = await paths();
    const fetchAvatar = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const service = new AvatarSyncService({ paths: store, fetchAvatar });
    const url = "https://avatars.githubusercontent.com/u/3?v=4";

    await expect(
      service.syncCommentAuthors({
        profileId,
        snapshot: snapshotWithCommentAvatars([url]),
      }),
    ).resolves.toBeUndefined();
    expect(await hasAvatar(store, profileId, hashAvatarUrl(url))).toBe(false);
  });

  it("stays silent (no error-level log) when offline", async () => {
    const store = await paths();
    const fetchAvatar = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const log = { write: vi.fn() };
    const service = new AvatarSyncService({ paths: store, fetchAvatar, log });
    const url = "https://avatars.githubusercontent.com/u/4?v=4";

    await service.syncCommentAuthors({
      profileId,
      snapshot: snapshotWithCommentAvatars([url]),
    });

    for (const call of log.write.mock.calls) {
      // SAFETY: this test's only log.write caller passes a LogEntryInput,
      // whose `level` field is all that's asserted below.
      const entry = call[0] as { readonly level: string };
      expect(entry.level).not.toBe("error");
      expect(entry.level).not.toBe("warn");
    }
  });

  it("resolves a fetcher that itself returns undefined as a skip, not a failure", async () => {
    const store = await paths();
    const fetchAvatar = vi.fn(async () => undefined);
    const service = new AvatarSyncService({ paths: store, fetchAvatar });
    const url = "https://avatars.githubusercontent.com/u/5?v=4";

    await service.syncCommentAuthors({
      profileId,
      snapshot: snapshotWithCommentAvatars([url]),
    });

    expect(await hasAvatar(store, profileId, hashAvatarUrl(url))).toBe(false);
  });

  it('surfaces the nested cause\'s message and code, since a failed undici fetch always reports the generic top-level message "fetch failed"', async () => {
    const store = await paths();
    const nestedCause = Object.assign(
      new Error("getaddrinfo ENOTFOUND avatars.githubusercontent.com"),
      { code: "ENOTFOUND" },
    );
    const fetchAvatar = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: nestedCause });
    });
    const log = { write: vi.fn() };
    const service = new AvatarSyncService({ paths: store, fetchAvatar, log });
    const url = "https://avatars.githubusercontent.com/u/6?v=4";

    await service.syncCommentAuthors({
      profileId,
      snapshot: snapshotWithCommentAvatars([url]),
    });

    expect(log.write).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          cause: "fetch failed",
          causeOfCause: "getaddrinfo ENOTFOUND avatars.githubusercontent.com",
          causeOfCauseCode: "ENOTFOUND",
        }),
      }),
    );
  });

  it("caps the number of avatars fetched in one sync", async () => {
    const store = await paths();
    const fetchAvatar = vi.fn(async () => ({ bytes }));
    const service = new AvatarSyncService({ paths: store, fetchAvatar });
    const urls = Array.from(
      { length: MAX_AVATARS_PER_SYNC + 10 },
      (_, index) => `https://avatars.githubusercontent.com/u/${index}?v=1`,
    );

    await service.syncCommentAuthors({
      profileId,
      snapshot: snapshotWithCommentAvatars(urls),
    });

    expect(fetchAvatar).toHaveBeenCalledTimes(MAX_AVATARS_PER_SYNC);
  });

  describe("warmAvatarUrls", () => {
    it("downloads and caches every URL in an explicit, already-prioritized set", async () => {
      const store = await paths();
      const fetchAvatar = vi.fn(async () => ({ bytes }));
      const service = new AvatarSyncService({ paths: store, fetchAvatar });
      const urls = [
        "https://avatars.githubusercontent.com/u/10?v=1",
        "https://avatars.githubusercontent.com/u/11?v=1",
      ];

      await service.warmAvatarUrls({ profileId, avatarUrls: urls });

      expect(fetchAvatar).toHaveBeenCalledTimes(2);
      for (const url of urls) {
        expect(await hasAvatar(store, profileId, hashAvatarUrl(url))).toBe(
          true,
        );
      }
    });

    it("caps the number fetched, keeping only the caller's priority-ordered prefix", async () => {
      const store = await paths();
      const fetchAvatar = vi.fn(async () => ({ bytes }));
      const service = new AvatarSyncService({ paths: store, fetchAvatar });
      const urls = Array.from(
        { length: MAX_AVATARS_PER_SYNC + 5 },
        (_, index) => `https://avatars.githubusercontent.com/u/${index}?v=2`,
      );

      await service.warmAvatarUrls({ profileId, avatarUrls: urls });

      expect(fetchAvatar).toHaveBeenCalledTimes(MAX_AVATARS_PER_SYNC);
      // The first URL in priority order was fetched...
      const first = urls[0];
      if (first === undefined) throw new Error("fixture");
      expect(await hasAvatar(store, profileId, hashAvatarUrl(first))).toBe(
        true,
      );
      // ...and the URLs past the cap were left unfetched.
      const overflow = urls[urls.length - 1];
      if (overflow === undefined) throw new Error("fixture");
      expect(await hasAvatar(store, profileId, hashAvatarUrl(overflow))).toBe(
        false,
      );
    });

    it("dedupes a URL that appears more than once, fetching it only once", async () => {
      const store = await paths();
      const fetchAvatar = vi.fn(async () => ({ bytes }));
      const service = new AvatarSyncService({ paths: store, fetchAvatar });
      const url = "https://avatars.githubusercontent.com/u/20?v=1";

      await service.warmAvatarUrls({
        profileId,
        avatarUrls: [url, url, url],
      });

      expect(fetchAvatar).toHaveBeenCalledTimes(1);
    });

    it("never fails when a fetch fails (non-fatal, same contract as syncCommentAuthors)", async () => {
      const store = await paths();
      const fetchAvatar = vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      });
      const service = new AvatarSyncService({ paths: store, fetchAvatar });

      await expect(
        service.warmAvatarUrls({
          profileId,
          avatarUrls: ["https://avatars.githubusercontent.com/u/21?v=1"],
        }),
      ).resolves.toBeUndefined();
    });
  });
});
