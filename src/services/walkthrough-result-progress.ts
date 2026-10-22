import type { WalkthroughProgressStore } from "#src/adapters/storage/walkthrough-progress-store";
import type { ReviewStore } from "#src/adapters/storage/review-store";
import {
  walkthroughReadingStateCodec,
  walkthroughReviewedSectionCodec,
  type WalkthroughProgressMutationRequest,
  type WalkthroughReadFailure,
  type WalkthroughReadingState,
} from "#src/domain/walkthrough-progress";
import { parseReviewId, parseWorkspaceProfileId } from "#src/domain/ids";
import { KeyedMutex } from "#src/domain/keyed-mutex";
import { err, ok, type Result } from "#src/domain/result";
import type {
  InsightArtifactIndexDescriptor,
  InsightArtifactReference,
} from "#src/domain/insight-artifact-scalars";
import type { ReviewOperationCoordinator } from "./review-operation-coordinator";
import {
  walkthroughReadFailure,
  type WalkthroughResultReader,
  type WalkthroughResultView,
} from "./walkthrough-result-reader";
import { walkthroughSection } from "./walkthrough-result-records";
import type { AppLogService } from "./app-log-service";
import type { StorageFailure } from "#src/adapters/storage/json-file";

type Progress = {
  readonly version: number;
  readonly currentSectionId: string | null;
  readonly reviewedCount: number;
};

/** Serializes optimistic intents, then rechecks the result and open Review under publication's Review lock. */
export class WalkthroughProgressService {
  private readonly locks = new KeyedMutex();
  constructor(
    private readonly store: WalkthroughProgressStore,
    private readonly reader: WalkthroughResultReader,
    private readonly operations: Pick<
      ReviewOperationCoordinator,
      "withReviewLock"
    >,
    private readonly reviews: Pick<ReviewStore, "load">,
    private readonly logs?: Pick<AppLogService, "write">,
  ) {}

  /** Missing progress is empty. Explicit malformed state never resets. */
  async describe(
    view: WalkthroughResultView,
  ): Promise<Result<Progress, WalkthroughReadFailure>> {
    const state = await this.read(view);
    if (state._tag === "err") return state;
    if (state.value === undefined)
      return ok({ version: 0, currentSectionId: null, reviewedCount: 0 });
    const { version, currentSectionId, reviewedSections } = state.value;
    return ok({
      version,
      currentSectionId,
      reviewedCount: reviewedSections.count,
    });
  }

  /** Resolves marks only for the requested navigation window, never the entire reviewed set. */
  async reviewed(
    view: WalkthroughResultView,
    sectionId: string,
  ): Promise<Result<boolean, WalkthroughReadFailure>> {
    const state = await this.read(view);
    if (state._tag === "err") return state;
    if (state.value === undefined) return ok(false);
    const index = state.value.reviewedSections;
    let low = 0;
    let high = index.count;
    const target = Number(sectionId.slice(1));
    while (low < high) {
      const at = Math.floor((low + high) / 2);
      const mark = await this.markAt(view, index, at);
      if (mark._tag === "err") return mark;
      const number = Number(mark.value.sectionId.slice(1));
      if (number === target) return ok(true);
      if (number < target) low = at + 1;
      else high = at;
    }
    return ok(false);
  }

  /** Saves one current user intent, fenced by both digest and progress version. */
  mutate(
    request: WalkthroughProgressMutationRequest,
  ): Promise<Result<{ readonly version: number }, WalkthroughReadFailure>> {
    return this.locks.run(
      `${request.profileId}\n${request.reviewId}\n${request.digest}`,
      () => this.apply(request),
    );
  }

  private async read(
    view: WalkthroughResultView,
  ): Promise<
    Result<WalkthroughReadingState | undefined, WalkthroughReadFailure>
  > {
    const stored = await this.store.read(
      view.profileId,
      view.reviewId,
      view.digest,
    );
    if (stored._tag === "err") return err(this.readFailure(stored.error));
    const state = stored.value?.state;
    if (state === undefined) return ok(undefined);
    const valid = await this.validateState(view, state);
    return valid._tag === "err" ? valid : ok(state);
  }

  private async validateState(
    view: WalkthroughResultView,
    state: WalkthroughReadingState,
  ): Promise<Result<void, WalkthroughReadFailure>> {
    if (state.reviewedSections.count > view.root.sections.count)
      return err("invalid_progress");
    if (state.currentSectionId !== null) {
      const section = await walkthroughSection(view, state.currentSectionId);
      if (section._tag === "err")
        return err(
          section.error === "storage_unavailable"
            ? this.unavailable("section_read")
            : "invalid_progress",
        );
    }
    const index = await view.store.readIndex(
      "WalkthroughReviewedSection1",
      state.reviewedSections,
      0,
      0,
    );
    return index._tag === "err"
      ? err(this.readFailure(index.error))
      : ok(undefined);
  }

  private async apply(
    request: WalkthroughProgressMutationRequest,
  ): Promise<Result<{ readonly version: number }, WalkthroughReadFailure>> {
    const profile = parseWorkspaceProfileId(request.profileId);
    const review = parseReviewId(request.reviewId);
    if (profile._tag === "err" || review._tag === "err")
      return err("not_available");
    const current = await this.reader.current(profile.value, review.value);
    if (current._tag === "err")
      return current.error === "storage_unavailable"
        ? err(this.unavailable("result_read"))
        : current;
    const view = current.value;
    if (view === undefined) return err("not_available");
    if (view.digest !== request.digest) return err("stale_result");
    const [prior, section] = await Promise.all([
      this.store.read(view.profileId, view.reviewId, view.digest),
      walkthroughSection(view, request.mutation.sectionId),
    ]);
    if (prior._tag === "err") return err(this.readFailure(prior.error));
    if (section._tag === "err")
      return err(
        section.error === "storage_unavailable"
          ? this.unavailable("section_read")
          : "invalid_progress",
      );
    const version = prior.value?.state.version ?? 0;
    if (version !== request.expectedVersion) return err("version_conflict");
    if (prior.value !== undefined) {
      const valid = await this.validateState(view, prior.value.state);
      if (valid._tag === "err") return valid;
      if (request.mutation.action === "set_current") {
        let previous = 0;
        for (
          let at = 0;
          at < prior.value.state.reviewedSections.count;
          at += 1
        ) {
          const mark = await this.markAt(
            view,
            prior.value.state.reviewedSections,
            at,
          );
          if (mark._tag === "err") return mark;
          const number = Number(mark.value.sectionId.slice(1));
          if (number <= previous) return err("invalid_progress");
          previous = number;
        }
      }
    }
    const empty =
      prior.value === undefined
        ? await view.store.emptyIndex("WalkthroughReviewedSection1")
        : ok(prior.value.state.reviewedSections);
    if (empty._tag === "err") return err(this.unavailable(empty.error.reason));
    let marks = empty.value;
    if (request.mutation.action === "set_reviewed") {
      const edited = await this.edit(
        view,
        marks,
        request.mutation.sectionId,
        request.mutation.value,
      );
      if (edited._tag === "err") return edited;
      marks = edited.value;
    }
    const next = version + 1;
    const state = await view.artifacts.writeObject(
      view.profileId,
      view.reviewId,
      walkthroughReadingStateCodec,
      {
        result: view.digest,
        version: next,
        reviewedSections: marks,
        currentSectionId:
          request.mutation.action === "set_current"
            ? request.mutation.sectionId
            : (prior.value?.state.currentSectionId ?? null),
      },
    );
    if (state._tag === "err") return err(this.unavailable(state.error.reason));
    return this.operations.withReviewLock(
      view.profileId,
      view.reviewId,
      async (): Promise<
        Result<{ readonly version: number }, WalkthroughReadFailure>
      > => {
        const [latest, owned] = await Promise.all([
          this.reader.current(view.profileId, view.reviewId),
          this.reviews.load(view.profileId, view.reviewId),
        ]);
        if (latest._tag === "err")
          return latest.error === "storage_unavailable"
            ? err(this.unavailable("result_read"))
            : latest;
        if (latest.value?.digest !== view.digest) return err("stale_result");
        if (owned._tag === "err") return err(this.unavailable("review_read"));
        if (owned.value.status._tag === "Terminal") return err("not_available");
        const saved = await this.store.commit(
          view.profileId,
          view.reviewId,
          view.digest,
          prior.value?.pointerBytes ?? null,
          next,
          state.value,
        );
        return saved._tag === "err"
          ? err(this.unavailable(saved.error.reason))
          : saved.value
            ? ok({ version: next })
            : err("version_conflict");
      },
    );
  }

  private async markAt(
    view: WalkthroughResultView,
    index: InsightArtifactIndexDescriptor,
    position: number,
  ): Promise<
    Result<
      {
        readonly sectionId: string;
        readonly reference: InsightArtifactReference;
      },
      WalkthroughReadFailure
    >
  > {
    const entries = await view.store.readIndex(
      "WalkthroughReviewedSection1",
      index,
      position,
      1,
    );
    if (entries._tag === "err") return err(this.readFailure(entries.error));
    const entry = entries.value[0];
    if (entry === undefined) return err("invalid_progress");
    const mark = await view.artifacts.readObject(
      view.profileId,
      view.reviewId,
      walkthroughReviewedSectionCodec,
      entry.value,
    );
    if (mark._tag === "err") return err(this.readFailure(mark.error));
    const section = await walkthroughSection(view, mark.value.sectionId);
    return section._tag === "err"
      ? err(
          section.error === "storage_unavailable"
            ? this.unavailable("section_read")
            : "invalid_progress",
        )
      : ok({ sectionId: mark.value.sectionId, reference: entry.value });
  }

  private readFailure(error: StorageFailure): WalkthroughReadFailure {
    if (error.reason === "invalid_stored_value") return "invalid_progress";
    return this.unavailable(error.reason);
  }

  private unavailable(
    category:
      | StorageFailure["reason"]
      | "result_read"
      | "section_read"
      | "review_read",
  ): "storage_unavailable" {
    this.logs?.write({
      process: "main",
      level: "warn",
      topic: "insight-artifact-read",
      message: "Walkthrough progress storage failed",
      meta: { category },
    });
    return "storage_unavailable";
  }

  private async edit(
    view: WalkthroughResultView,
    index: InsightArtifactIndexDescriptor,
    sectionId: string,
    value: boolean,
  ): Promise<Result<InsightArtifactIndexDescriptor, WalkthroughReadFailure>> {
    const empty = await view.store.emptyIndex("WalkthroughReviewedSection1");
    if (empty._tag === "err") {
      const failure = walkthroughReadFailure(empty.error);
      return err(
        failure === "storage_unavailable"
          ? this.unavailable(empty.error.reason)
          : failure,
      );
    }
    let rebuilt = empty.value;
    const target = Number(sectionId.slice(1));
    let inserted = false;
    let previous = 0;
    const append = async (
      reference: InsightArtifactReference,
    ): Promise<Result<void, WalkthroughReadFailure>> => {
      const next = await view.store.appendIndex(
        "WalkthroughReviewedSection1",
        rebuilt,
        rebuilt.count,
        reference,
      );
      if (next._tag === "err") return err(this.unavailable(next.error.reason));
      rebuilt = next.value;
      return ok(undefined);
    };
    const add = async (): Promise<Result<void, WalkthroughReadFailure>> => {
      inserted = true;
      if (!value) return ok(undefined);
      const mark = await view.artifacts.writeObject(
        view.profileId,
        view.reviewId,
        walkthroughReviewedSectionCodec,
        { sectionId },
      );
      return mark._tag === "err"
        ? err(this.unavailable(mark.error.reason))
        : append(mark.value);
    };
    // Rebuild streams one mark at a time; memory does not grow with the reviewed set.
    for (let at = 0; at < index.count; at += 1) {
      const mark = await this.markAt(view, index, at);
      if (mark._tag === "err") return mark;
      const number = Number(mark.value.sectionId.slice(1));
      if (number <= previous) return err("invalid_progress");
      previous = number;
      if (!inserted && number >= target) {
        const added = await add();
        if (added._tag === "err") return added;
      }
      if (number !== target) {
        const appended = await append(mark.value.reference);
        if (appended._tag === "err") return appended;
      }
    }
    if (!inserted) {
      const added = await add();
      if (added._tag === "err") return added;
    }
    return ok(rebuilt);
  }
}
