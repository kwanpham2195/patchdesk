import type { GuideProgressStore } from "#src/adapters/storage/guide-progress-store";
import type { InsightIndexElement } from "#src/domain/insight-artifact-index";
import type { StorageFailure } from "#src/adapters/storage/json-file";
import {
  guideExpandedAppearanceCodec,
  guideReadingStateCodec,
  guideReviewedGroupCodec,
  parseGuideAnchorText,
  type GuideAnchor,
  type GuidePage,
  type GuideProgressMutationRequest,
  type GuideReadFailure,
  type GuideReadingState,
} from "#src/domain/guide-progress";
import {
  guideGroupCodec,
  guideInventoryEntryCodec,
  guideMemberCodec,
} from "#src/domain/guide-result";
import type { InsightArtifactCodec } from "#src/domain/insight-artifact-index";
import {
  encodeInsightArtifactCanonicalJson,
  type InsightArtifactIndexDescriptor,
  type InsightArtifactReference,
  type InsightCanonicalValue,
} from "#src/domain/insight-artifact-scalars";
import { parseReviewId, parseWorkspaceProfileId } from "#src/domain/ids";
import { KeyedMutex } from "#src/domain/keyed-mutex";
import { err, ok, type Result } from "#src/domain/result";
import type * as v from "valibot";
import { GuideProgressPages } from "./guide-progress-pages";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import type { GuideResultReader, GuideResultView } from "./guide-result-reader";

/** Order of a mark: group number (Others last), then file number. No numeric packing, so no identity can collide. */
type Rank = readonly [number, number];

type Appearance = { readonly groupId: string; readonly fileId: string };

/**
 * Digest-keyed reading progress over the published Guide. Each save changes one reviewed mark, one expanded
 * appearance or the anchor, under an expected version and the exact result digest, and names only identities the
 * published result actually contains. The legacy InsightRecord is never read or rewritten; absent progress is empty
 * and a malformed explicit root is an error, not a reset.
 */
export class GuideProgressService {
  private readonly locks = new KeyedMutex();
  private readonly pages: GuideProgressPages;

  constructor(
    private readonly store: GuideProgressStore,
    private readonly reader: GuideResultReader,
    private readonly operations: Pick<
      ReviewOperationCoordinator,
      "withReviewLock"
    >,
  ) {
    this.pages = new GuideProgressPages(store);
  }

  async describe(
    view: GuideResultView,
  ): Promise<
    Result<
      { readonly version: number; readonly anchor: GuideAnchor },
      GuideReadFailure
    >
  > {
    const state = await this.store.read(
      view.profileId,
      view.reviewId,
      view.digest,
    );
    if (state._tag === "err") return err(storageReason(state.error));
    if (state.value === undefined)
      return ok({ version: 0, anchor: { kind: "top" } });
    const anchor = await this.anchorOf(view, state.value.state);
    return anchor === undefined
      ? err("invalid_progress")
      : ok({ version: state.value.state.version, anchor });
  }

  readPage(
    view: GuideResultView,
    kind: "reviewed" | "expanded",
    cursor: string | null,
  ): Promise<Result<GuidePage, GuideReadFailure>> {
    return this.pages.readPage(view, kind, cursor);
  }

  mutate(
    request: GuideProgressMutationRequest,
  ): Promise<Result<{ readonly version: number }, GuideReadFailure>> {
    return this.locks.run(
      `${request.profileId}\n${request.reviewId}\n${request.digest}`,
      () => this.apply(request),
    );
  }

  private async apply(
    request: GuideProgressMutationRequest,
  ): Promise<Result<{ readonly version: number }, GuideReadFailure>> {
    const parsedProfile = parseWorkspaceProfileId(request.profileId);
    const parsedReview = parseReviewId(request.reviewId);
    if (parsedProfile._tag === "err" || parsedReview._tag === "err")
      return err("not_available");
    const profileId = parsedProfile.value;
    const reviewId = parsedReview.value;
    const current = await this.reader.current(profileId, reviewId);
    if (current._tag === "err") return err(current.error);
    const view = current.value;
    if (view === undefined) return err("not_available");
    if (view.digest !== request.digest) return err("stale_result");
    const stored = await this.store.read(profileId, reviewId, view.digest);
    if (stored._tag === "err") return err(storageReason(stored.error));
    const version = stored.value?.state.version ?? 0;
    if (version !== request.expectedVersion) return err("version_conflict");
    const prior = stored.value?.state;
    let reviewed =
      prior?.reviewedGroups ?? (await this.empty(view, "GuideReviewedGroup1"));
    let expanded =
      prior?.expanded ?? (await this.empty(view, "GuideExpandedAppearance1"));
    if (reviewed === undefined || expanded === undefined)
      return err("storage_unavailable");
    let anchor = prior?.anchor;
    const mutation = request.mutation;
    if (mutation.action === "set_reviewed") {
      if (!this.groupExists(view, mutation.groupId))
        return err("invalid_progress");
      const edited = await this.edit(
        view,
        "GuideReviewedGroup1",
        guideReviewedGroupCodec,
        reviewed,
        (item) => [groupNumber(item.groupId), 0],
        [groupNumber(mutation.groupId), 0],
        mutation.value ? { groupId: mutation.groupId } : undefined,
      );
      if (edited._tag === "err") return edited;
      if (edited.value === undefined) return ok({ version });
      reviewed = edited.value;
    } else if (mutation.action === "set_expanded") {
      const member = await this.appears(view, {
        groupId: mutation.groupId,
        fileId: mutation.fileId,
      });
      if (member._tag === "err") return member;
      if (!member.value) return err("invalid_progress");
      const rank = appearanceRank(mutation.groupId, mutation.fileId);
      const edited = await this.edit(
        view,
        "GuideExpandedAppearance1",
        guideExpandedAppearanceCodec,
        expanded,
        (item) => appearanceRank(item.groupId, item.fileId),
        rank,
        mutation.value
          ? { groupId: mutation.groupId, fileId: mutation.fileId }
          : undefined,
      );
      if (edited._tag === "err") return edited;
      if (edited.value === undefined) return ok({ version });
      expanded = edited.value;
    } else {
      let valid = true;
      if (mutation.anchor.kind === "group")
        valid = this.groupExists(view, mutation.anchor.groupId);
      else if (mutation.anchor.kind === "file") {
        const found = await this.appears(view, mutation.anchor);
        if (found._tag === "err") return found;
        valid = found.value;
      }
      if (valid !== true) return err("invalid_progress");
      const root = await view.artifacts.writeTextRoot(
        profileId,
        reviewId,
        encodeInsightArtifactCanonicalJson(mutation.anchor) ?? "",
      );
      if (root._tag === "err") return err("storage_unavailable");
      anchor = root.value;
    }
    if (anchor === undefined) {
      const top = await view.artifacts.writeTextRoot(
        profileId,
        reviewId,
        encodeInsightArtifactCanonicalJson({ kind: "top" }) ?? "",
      );
      if (top._tag === "err") return err("storage_unavailable");
      anchor = top.value;
    }
    const next = version + 1;
    const root = await view.artifacts.writeObject(
      profileId,
      reviewId,
      guideReadingStateCodec,
      {
        result: view.digest,
        version: next,
        reviewedGroups: reviewed,
        expanded,
        anchor,
      },
    );
    if (root._tag === "err") return err("storage_unavailable");
    // The result is rechecked under the Review lock that publication also takes, immediately before the compare-and-replace.
    const committed = await this.operations.withReviewLock(
      profileId,
      reviewId,
      async (): Promise<Result<boolean, GuideReadFailure>> => {
        const latest = await this.reader.current(profileId, reviewId);
        if (latest._tag === "err") return err(latest.error);
        if (latest.value?.digest !== view.digest)
          return err("stale_result" as const);
        const saved = await this.store.commit(
          profileId,
          reviewId,
          view.digest,
          stored.value?.pointerBytes ?? null,
          next,
          root.value,
        );
        return saved._tag === "err" ? err("storage_unavailable") : saved;
      },
    );
    if (committed._tag === "err") return err(committed.error);
    return committed.value ? ok({ version: next }) : err("version_conflict");
  }

  private groupExists(view: GuideResultView, groupId: string): boolean {
    const number = groupNumber(groupId);
    return number >= 1 && number <= view.root.groups.count;
  }

  /** Whether the appearance names a file the group (or Others) actually contains. */
  private async appears(
    view: GuideResultView,
    appearance: Appearance,
  ): Promise<Result<boolean, GuideReadFailure>> {
    if (appearance.groupId === "others") {
      const others = await view.store.readWholeIndex(
        "GuideInventoryEntry1",
        view.root.others,
      );
      if (others._tag === "err") return err("storage_unavailable");
      for (const entry of others.value) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Others is a bounded inventory subset
        const record = await view.artifacts.readObject(
          view.profileId,
          view.reviewId,
          guideInventoryEntryCodec,
          entry.value,
        );
        if (record._tag === "err") return err("storage_unavailable");
        if (record.value.fileId === appearance.fileId) return ok(true);
      }
      return ok(false);
    }
    if (!this.groupExists(view, appearance.groupId)) return ok(false);
    const group = await this.groupAt(view, groupNumber(appearance.groupId) - 1);
    if (group === undefined) return err("storage_unavailable");
    const members = await view.store.readWholeIndex(
      "GuideMember1",
      group.members,
    );
    if (members._tag === "err") return err("storage_unavailable");
    for (const entry of members.value) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- one group's members are bounded by the inventory
      const member = await view.artifacts.readObject(
        view.profileId,
        view.reviewId,
        guideMemberCodec,
        entry.value,
      );
      if (member._tag === "err") return err("storage_unavailable");
      if (member.value.fileId === appearance.fileId) return ok(true);
    }
    return ok(false);
  }

  private async groupAt(view: GuideResultView, position: number) {
    const found = await view.store.readIndex(
      "GuideGroup1",
      view.root.groups,
      position,
      1,
    );
    if (found._tag === "err" || found.value[0] === undefined) return undefined;
    const group = await view.artifacts.readObject(
      view.profileId,
      view.reviewId,
      guideGroupCodec,
      found.value[0].value,
    );
    return group._tag === "ok" ? group.value : undefined;
  }

  private async empty(view: GuideResultView, element: InsightIndexElement) {
    const index = await view.store.emptyIndex(element);
    return index._tag === "ok" ? index.value : undefined;
  }

  /**
   * Adds or removes one set member, keeping the index in rank order. An addition after every present rank appends;
   * anything else rebuilds the index from the same member objects. `undefined` means no change was needed.
   */
  private async edit<
    TSchema extends v.GenericSchema<unknown, InsightCanonicalValue>,
  >(
    view: GuideResultView,
    element: InsightIndexElement,
    codec: InsightArtifactCodec<TSchema>,
    index: InsightArtifactIndexDescriptor,
    rank: (item: v.InferOutput<TSchema>) => Rank,
    target: Rank,
    add: v.InferInput<TSchema> | undefined,
  ): Promise<
    Result<InsightArtifactIndexDescriptor | undefined, GuideReadFailure>
  > {
    const entries = await view.store.readWholeIndex(element, index);
    if (entries._tag === "err") return err("invalid_progress");
    const present: Array<{ rank: Rank; ref: InsightArtifactReference }> = [];
    for (const entry of entries.value) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- bounded set of small marks
      const item = await view.artifacts.readObject(
        view.profileId,
        view.reviewId,
        codec,
        entry.value,
      );
      if (item._tag === "err") return err("invalid_progress");
      present.push({ rank: rank(item.value), ref: entry.value });
    }
    const existing = present.some(
      (entry) => compareRank(entry.rank, target) === 0,
    );
    if (add === undefined ? !existing : existing) return ok(undefined);
    let written: InsightArtifactReference | undefined;
    if (add !== undefined) {
      const object = await view.artifacts.writeObject(
        view.profileId,
        view.reviewId,
        codec,
        add,
      );
      if (object._tag === "err") return err("storage_unavailable");
      written = object.value;
    }
    const last = present.at(-1);
    if (
      written !== undefined &&
      (last === undefined || compareRank(target, last.rank) > 0)
    ) {
      const appended = await view.store.appendIndex(
        element,
        index,
        present.length,
        written,
      );
      return appended._tag === "ok"
        ? ok(appended.value)
        : err("storage_unavailable");
    }
    const next = present.filter(
      (entry) => compareRank(entry.rank, target) !== 0,
    );
    if (written !== undefined) next.push({ rank: target, ref: written });
    next.sort((left, right) => compareRank(left.rank, right.rank));
    let rebuilt = await view.store.emptyIndex(element);
    for (const [ordinal, entry] of next.entries()) {
      if (rebuilt._tag === "err") break;
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- index appends are ordered
      rebuilt = await view.store.appendIndex(
        element,
        rebuilt.value,
        ordinal,
        entry.ref,
      );
    }
    return rebuilt._tag === "ok"
      ? ok(rebuilt.value)
      : err("storage_unavailable");
  }

  private async anchorOf(
    view: GuideResultView,
    state: GuideReadingState,
  ): Promise<GuideAnchor | undefined> {
    const text = await view.store.readText(state.anchor, 4_096);
    if (text._tag === "err") return undefined;
    const parsed = parseGuideAnchorText(text.value);
    return parsed._tag === "ok" ? parsed.value : undefined;
  }
}

function groupNumber(groupId: string): number {
  return Number(groupId.slice(1));
}

function appearanceRank(groupId: string, fileId: string): Rank {
  return [
    groupId === "others" ? Number.POSITIVE_INFINITY : groupNumber(groupId),
    Number(fileId.slice(1)),
  ];
}

function compareRank(left: Rank, right: Rank): number {
  return left[0] === right[0]
    ? left[1] - right[1]
    : left[0] < right[0]
      ? -1
      : 1;
}

function storageReason(error: StorageFailure): GuideReadFailure {
  return error.reason === "invalid_stored_value"
    ? "invalid_progress"
    : "storage_unavailable";
}
