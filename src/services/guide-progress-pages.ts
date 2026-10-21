import type { GuideProgressStore } from "#src/adapters/storage/guide-progress-store";
import type { StorageFailure } from "#src/adapters/storage/json-file";
import * as v from "valibot";

import {
  guideExpandedAppearanceCodec,
  guideReadingStateCodec,
  guideReviewedGroupCodec,
  type GuidePage,
  type GuideReadFailure,
} from "#src/domain/guide-progress";
import type {
  InsightArtifactCodec,
  InsightIndexElement,
} from "#src/domain/insight-artifact-index";
import {
  insightArtifactReferenceSchema,
  type InsightArtifactIndexDescriptor,
  type InsightArtifactReference,
  type InsightCanonicalValue,
} from "#src/domain/insight-artifact-scalars";
import { err, ok, type Result } from "#src/domain/result";
import {
  cursorBody,
  decodeCursor,
  encodeCursor,
} from "./guide-result-projection";
import type { GuideResultView } from "./guide-result-reader";

const REVIEWED_PAGE = 200;
const EXPANDED_PAGE = 100;

/**
 * Pages of reviewed marks and expanded appearances. The first page snapshots the current progress root and every
 * continuation cursor pins that immutable root and version, so a save between two page reads can never splice
 * versions into one listing.
 */
export class GuideProgressPages {
  constructor(private readonly store: GuideProgressStore) {}

  async readPage(
    view: GuideResultView,
    kind: "reviewed" | "expanded",
    cursor: string | null,
  ): Promise<Result<GuidePage, GuideReadFailure>> {
    // The first page snapshots the current progress root; every continuation reads that same immutable root, so a
    // save between pages cannot splice two versions into one listing.
    const continued = cursor === null ? undefined : cursorBody(cursor);
    const root =
      continued === undefined
        ? await this.currentRoot(view)
        : this.pinnedRoot(continued.s);
    if (root._tag === "err") return err(root.error);
    const scope =
      root.value === undefined
        ? "empty"
        : `${root.value.hash}:${root.value.bytes}`;
    const position = decodeCursor(cursor, { digest: view.digest, kind, scope });
    if (position === undefined) return err("invalid_cursor");
    const state =
      root.value === undefined
        ? undefined
        : await view.artifacts.readObject(
            view.profileId,
            view.reviewId,
            guideReadingStateCodec,
            root.value,
          );
    if (
      state !== undefined &&
      (state._tag === "err" || state.value.result !== view.digest)
    )
      return err("invalid_progress");
    const empty = { reviewed: 0, expanded: 0 };
    const index =
      state?.value[kind === "reviewed" ? "reviewedGroups" : "expanded"];
    const count = index?.count ?? empty[kind];
    const limit = kind === "reviewed" ? REVIEWED_PAGE : EXPANDED_PAGE;
    if (position.p > count) return err("invalid_cursor");
    const next =
      position.p + limit < count
        ? encodeCursor({
            d: view.digest,
            k: kind,
            s: scope,
            p: position.p + limit,
          })
        : null;
    if (index === undefined || count === 0)
      return ok(
        kind === "reviewed"
          ? { kind, groups: [], next }
          : { kind, appearances: [], next },
      );
    if (kind === "reviewed") {
      const items = await this.items(
        view,
        "GuideReviewedGroup1",
        guideReviewedGroupCodec,
        index,
        position.p,
        limit,
      );
      return items._tag === "err"
        ? items
        : ok({ kind, groups: items.value.map((item) => item.groupId), next });
    }
    const items = await this.items(
      view,
      "GuideExpandedAppearance1",
      guideExpandedAppearanceCodec,
      index,
      position.p,
      limit,
    );
    return items._tag === "err"
      ? items
      : ok({ kind, appearances: [...items.value], next });
  }

  private async currentRoot(
    view: GuideResultView,
  ): Promise<Result<InsightArtifactReference | undefined, GuideReadFailure>> {
    const stored = await this.store.read(
      view.profileId,
      view.reviewId,
      view.digest,
    );
    return stored._tag === "err"
      ? err(storageReason(stored.error))
      : ok(stored.value?.pointer.state);
  }

  /** The root a cursor pinned, decoded from its scope; it must still be a stored root of this result. */
  private pinnedRoot(
    scope: string,
  ): Result<InsightArtifactReference | undefined, GuideReadFailure> {
    if (scope === "empty") return ok(undefined);
    const [hash, bytes] = scope.split(":");
    const reference = v.safeParse(insightArtifactReferenceSchema, {
      hash,
      bytes: Number(bytes),
    });
    return reference.success ? ok(reference.output) : err("invalid_cursor");
  }

  private async items<
    TSchema extends v.GenericSchema<unknown, InsightCanonicalValue>,
  >(
    view: GuideResultView,
    element: InsightIndexElement,
    codec: InsightArtifactCodec<TSchema>,
    index: InsightArtifactIndexDescriptor,
    position: number,
    limit: number,
  ): Promise<Result<ReadonlyArray<v.InferOutput<TSchema>>, GuideReadFailure>> {
    const window = await view.store.readIndex(element, index, position, limit);
    if (window._tag === "err") return err("invalid_progress");
    const out: Array<v.InferOutput<TSchema>> = [];
    for (const entry of window.value) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- a page is at most a few hundred small objects
      const item = await view.artifacts.readObject(
        view.profileId,
        view.reviewId,
        codec,
        entry.value,
      );
      if (item._tag === "err") return err("invalid_progress");
      out.push(item.value);
    }
    return ok(out);
  }
}

function storageReason(error: StorageFailure): GuideReadFailure {
  return error.reason === "invalid_stored_value"
    ? "invalid_progress"
    : "storage_unavailable";
}
