import { readdir } from "node:fs/promises";

import type {
  IsoTimestamp,
  ReviewId,
  WorkspaceProfileId,
} from "../../domain/ids";
import { parseReviewId, parseWorkspaceProfileId } from "../../domain/ids";
import { KeyedMutex } from "../../domain/keyed-mutex";
import { err, ok, type Result } from "../../domain/result";
import { parseReview, type Review } from "../../domain/review";
import {
  isNotFound,
  readJsonFile,
  removePath,
  writeAtomicJson,
  type StorageFailure,
} from "./json-file";
import type { PatchdeskPaths } from "./patchdesk-paths";

type ReviewStoreConflict = {
  readonly _tag: "ReviewConflict";
  readonly reason: "stale_revision" | "terminal";
};

export type ReviewStoreFailure = StorageFailure | ReviewStoreConflict;

/** Every readable Review in one profile, plus how many records were skipped. */
export type ReviewListing = {
  readonly reviews: ReadonlyArray<Review>;
  readonly unreadable: number;
};

/** Owns one durable Review aggregate per workspace profile and pull request. */
export class ReviewStore {
  private readonly saveLocks = new KeyedMutex();

  constructor(private readonly paths: PatchdeskPaths) {}

  async load(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<Review, StorageFailure>> {
    const stored = await readJsonFile(
      this.paths.reviewFile(profileId, reviewId),
    );
    if (stored._tag === "err") return stored;
    const review = parseReview(stored.value);
    if (review._tag === "err") return invalidRead();
    if (
      review.value.identity.profileId !== profileId ||
      review.value.id !== reviewId
    ) {
      return invalidRead();
    }
    return review;
  }

  /**
   * Save one Review using its previous updatedAt as the compare-and-set token.
   * The token is omitted only when creating a new Review; an existing Review
   * can never be silently replaced by a stale caller.
   */
  async save(
    review: unknown,
    expectedUpdatedAt?: IsoTimestamp,
  ): Promise<Result<void, ReviewStoreFailure>> {
    const parsed = parseReview(review);
    if (parsed._tag === "err") return invalidWrite();

    const value = parsed.value;
    const key = `${value.identity.profileId}\n${value.id}`;
    return this.saveLocks.run(key, async () => {
      const current = await this.load(value.identity.profileId, value.id);
      if (current._tag === "err") {
        if (current.error.reason !== "not_found") return current;
        if (expectedUpdatedAt !== undefined) return staleConflict();
      } else {
        if (
          current.value.status._tag === "Terminal" &&
          value.status._tag !== "Terminal"
        ) {
          return terminalConflict();
        }
        if (
          expectedUpdatedAt === undefined ||
          current.value.updatedAt !== expectedUpdatedAt
        ) {
          return staleConflict();
        }
      }

      if (
        current._tag === "ok" &&
        Date.parse(value.updatedAt) <= Date.parse(current.value.updatedAt)
      ) {
        return staleConflict();
      }
      return writeAtomicJson(
        this.paths.reviewFile(value.identity.profileId, value.id),
        value,
      );
    });
  }

  /**
   * Remove one Review's whole directory: the record, its Insights, its
   * observation journal and its recent-write journal. Removing only the record
   * would leave those behind as orphans. A directory that is already gone is
   * success. Serialized against `save` on the same key so a delete cannot
   * interleave with a compare-and-set write.
   */
  async delete(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<void, StorageFailure>> {
    const key = `${profileId}\n${reviewId}`;
    return this.saveLocks.run(key, () =>
      removePath(this.paths.reviewDirectory(profileId, reviewId)),
    );
  }

  async findOwner(
    reviewId: ReviewId,
  ): Promise<Result<WorkspaceProfileId | undefined, StorageFailure>> {
    let profileEntries: ReadonlyArray<string>;
    try {
      profileEntries = await readdir(this.paths.dataProfilesDirectory());
    } catch (cause: unknown) {
      if (isNotFound(cause)) return ok(undefined);
      return err({ _tag: "StorageFailure", operation: "read", reason: "io" });
    }
    for (const entry of profileEntries) {
      const profileId = parseWorkspaceProfileId(entry);
      if (profileId._tag === "err") continue;
      const review = await this.load(profileId.value, reviewId);
      if (review._tag === "ok") return ok(profileId.value);
      if (review.error.reason !== "not_found") return review;
    }
    return ok(undefined);
  }

  /**
   * Read every Review in one profile, newest updatedAt first. There is no
   * index: this opens each review file under the profile in turn. A record
   * that cannot be read is skipped and counted in `unreadable` so one corrupt
   * file costs the caller that row rather than the whole listing.
   */
  async list(
    profileId: WorkspaceProfileId,
  ): Promise<Result<ReviewListing, StorageFailure>> {
    let entries: ReadonlyArray<string>;
    try {
      entries = await readdir(
        this.paths.profileWorkbenchesDirectory(profileId),
      );
    } catch (cause: unknown) {
      if (isNotFound(cause)) return ok({ reviews: [], unreadable: 0 });
      return err({ _tag: "StorageFailure", operation: "read", reason: "io" });
    }

    const reviews: Review[] = [];
    let unreadable = 0;
    for (const entry of entries) {
      const reviewId = parseReviewId(entry);
      if (reviewId._tag === "err") continue;
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- a profile holds few Reviews, and reading them one at a time holds one descriptor open instead of one per record
      const review = await this.load(profileId, reviewId.value);
      if (review._tag === "err") {
        // A vanished file is an ordinary race with deletion, not a lost record.
        if (review.error.reason !== "not_found") unreadable += 1;
        continue;
      }
      reviews.push(review.value);
    }

    reviews.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
    return ok({ reviews, unreadable });
  }
}

function invalidRead(): Result<never, StorageFailure> {
  return err({
    _tag: "StorageFailure",
    operation: "read",
    reason: "invalid_stored_value",
  });
}

function invalidWrite(): Result<never, StorageFailure> {
  return err({
    _tag: "StorageFailure",
    operation: "write",
    reason: "invalid_stored_value",
  });
}

function staleConflict(): Result<never, ReviewStoreConflict> {
  return err({ _tag: "ReviewConflict", reason: "stale_revision" });
}

function terminalConflict(): Result<never, ReviewStoreConflict> {
  return err({ _tag: "ReviewConflict", reason: "terminal" });
}
