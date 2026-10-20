import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";

import {
  parseReviewId,
  parseWorkspaceProfileId,
  type ReviewId,
  type WorkspaceProfileId,
} from "#src/domain/ids";
import { err, ok, type Result } from "#src/domain/result";
import { mapConcurrent } from "#src/domain/map-concurrent";
import type { StorageFailure } from "./json-file";

/** Name prefix of every disposable diagnostic scope directory under the cache. */
export const DIAGNOSTIC_SCOPE_PREFIX = "insight-patch-diagnostic-";

const markerName = ".guide-scope.json";
const maxMarkerBytes = 4 * 1024;
const markerSchema = v.strictObject({
  format: v.literal(1),
  profileId: v.string(),
  reviewId: v.string(),
});

/** A disposable scope that holds Guide preparation state for one Review. */
export type GuideScope = {
  readonly path: string;
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
};

/** Records which Review a new scope prepares for, so a later process can find and settle an interrupted run. */
export async function registerGuideScope(
  scope: GuideScope,
): Promise<Result<void, StorageFailure>> {
  try {
    const file = await open(
      join(scope.path, markerName),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(
        JSON.stringify({
          format: 1,
          profileId: scope.profileId,
          reviewId: scope.reviewId,
        }),
      );
    } finally {
      await file.close();
    }
    return ok(undefined);
  } catch {
    return err({ _tag: "StorageFailure", operation: "write", reason: "io" });
  }
}

/** Lists the registered scopes under `cache`; a directory without a valid marker is not a Guide scope and is skipped. */
export async function discoverGuideScopes(
  cache: string,
): Promise<ReadonlyArray<GuideScope>> {
  let names: string[];
  try {
    names = await readdir(cache);
  } catch {
    return [];
  }
  const scopes = await mapConcurrent(
    names.filter((name) => name.startsWith(DIAGNOSTIC_SCOPE_PREFIX)),
    4,
    async (name): Promise<GuideScope | undefined> => {
      const path = join(cache, name);
      try {
        if (!(await lstat(path)).isDirectory()) return undefined;
        const file = await open(
          join(path, markerName),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > maxMarkerBytes) return undefined;
          const marker = v.safeParse(
            markerSchema,
            JSON.parse(await file.readFile("utf8")),
          );
          if (!marker.success) return undefined;
          const profileId = parseWorkspaceProfileId(marker.output.profileId);
          const reviewId = parseReviewId(marker.output.reviewId);
          if (profileId._tag === "ok" && reviewId._tag === "ok")
            return {
              path,
              profileId: profileId.value,
              reviewId: reviewId.value,
            };
        } finally {
          await file.close().catch(() => undefined);
        }
      } catch {
        // An unreadable scope is left alone; the next pass tries again.
      }
      return undefined;
    },
  );
  return scopes.filter((scope) => scope !== undefined);
}
