import type { GuideRunStatus, GuideSummary } from "#src/domain/guide-progress";
import { GuideResultStore } from "#src/adapters/storage/guide-result-store";
import { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import type { readBoundedInsightArtifactFile } from "#src/adapters/storage/insight-artifact-files";
import { InsightRunJournalReader } from "#src/adapters/storage/insight-run-journal-reader";
import { InsightSlotStore } from "#src/adapters/storage/insight-slot-store";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import {
  guideDispatchIntentCodec,
  guidePublicationCodec,
  guideResultRootCodec,
  type GuideResultRoot,
} from "#src/domain/guide-result";
import {
  parseInsightRunId,
  type ReviewId,
  type WorkspaceProfileId,
} from "#src/domain/ids";
import { INSIGHT_FAILURE_CATEGORIES } from "#src/domain/insight-record";
import type { InsightSlotRecord3 } from "#src/domain/insight-slot-contract";
import type { InsightArtifactReference } from "#src/domain/insight-artifact-scalars";
import {
  insightBindingCodec,
  insightDomainIdentityCodec,
  insightLegacyFailureCodec,
} from "#src/domain/insight-run-binding-contract";
import { err, ok, type Result } from "#src/domain/result";

/** The one published Guide a Review's slot names, with the handles page reads need. */
export type GuideResultView = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  /** The result root's SHA-256: every read, cursor and progress save binds this exact digest. */
  readonly digest: InsightArtifactReference["hash"];
  readonly runId: string;
  readonly rootReference: InsightArtifactReference;
  readonly root: GuideResultRoot;
  readonly store: GuideResultStore;
  readonly artifacts: InsightArtifactStore;
};

/** Why a published Guide could not be selected; an unsupported or historical result is simply absent. */
export type GuideResultFailure = "invalid_result" | "storage_unavailable";

type GuideSummarySource = {
  readonly view: GuideResultView | undefined;
  readonly run: GuideRunStatus;
  readonly failure: GuideSummary["failure"];
};

/**
 * Selects and strictly decodes `GuideResultRoot1` only. A slot with no generated pointer, a historical or legacy
 * retained value, or no slot at all is absent; there is no fallback to any older result or progress format.
 */
export class GuideResultReader {
  private readonly slots: InsightSlotStore;
  private readonly artifacts: InsightArtifactStore;
  private readonly journals: InsightRunJournalReader;

  constructor(
    paths: PatchdeskPaths,
    reader: typeof readBoundedInsightArtifactFile,
  ) {
    this.slots = new InsightSlotStore(paths, reader);
    this.artifacts = new InsightArtifactStore(paths, reader);
    this.journals = new InsightRunJournalReader(paths, this.artifacts, reader);
  }

  async current(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<GuideResultView | undefined, GuideResultFailure>> {
    const slot = await this.slots.read(profileId, reviewId, "guide");
    if (slot._tag === "err") return err("storage_unavailable");
    return this.publishedFromSlot(profileId, reviewId, slot.value);
  }

  /** One validated slot snapshot selects the retained result, active run and last admitted failure together. */
  async summarySource(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<GuideSummarySource, GuideResultFailure>> {
    const slot = await this.slots.read(profileId, reviewId, "guide");
    if (slot._tag === "err") return err("storage_unavailable");
    const view = await this.publishedFromSlot(profileId, reviewId, slot.value);
    if (view._tag === "err") return view;
    const run = await this.activeRunFromSlot(profileId, reviewId, slot.value);
    if (run._tag === "err") return run;
    const failure = await this.failureFromSlot(profileId, reviewId, slot.value);
    if (failure._tag === "err") return failure;
    if (failure.value !== null && view.value?.runId === failure.value.runId)
      return err("invalid_result");
    return ok({ view: view.value, run: run.value, failure: failure.value });
  }

  private async publishedFromSlot(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    slot: InsightSlotRecord3 | undefined,
  ): Promise<Result<GuideResultView | undefined, GuideResultFailure>> {
    const retained = slot?.retained;
    if (
      slot === undefined ||
      retained?.tag !== "generated" ||
      slot.publication === null
    )
      return ok(undefined);
    const [publication, root] = await Promise.all([
      this.artifacts.readObject(
        profileId,
        reviewId,
        guidePublicationCodec,
        slot.publication,
      ),
      this.artifacts.readObject(
        profileId,
        reviewId,
        guideResultRootCodec,
        retained.root,
      ),
    ]);
    if (publication._tag === "err" || root._tag === "err")
      return err("invalid_result");
    // The publication and the retained pointer were committed together; a mismatch is corruption.
    if (
      publication.value.result.hash !== retained.root.hash ||
      publication.value.validation.hash !== root.value.validation.hash
    )
      return err("invalid_result");
    return ok({
      profileId,
      reviewId,
      digest: retained.root.hash,
      runId: publication.value.runId,
      rootReference: retained.root,
      root: root.value,
      store: new GuideResultStore(this.artifacts, profileId, reviewId),
      artifacts: this.artifacts,
    });
  }

  /**
   * The Guide run the slot names as active, in the vocabulary the reopened workbench needs: no provider call, one
   * journal read, and for a paused run the newest unresolved request a Resume must acknowledge.
   */
  async activeRun(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<Result<GuideRunStatus, GuideResultFailure>> {
    const slot = await this.slots.read(profileId, reviewId, "guide");
    if (slot._tag === "err") return err("storage_unavailable");
    return this.activeRunFromSlot(profileId, reviewId, slot.value);
  }

  private async activeRunFromSlot(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    slot: InsightSlotRecord3 | undefined,
  ): Promise<Result<GuideRunStatus, GuideResultFailure>> {
    const active = slot?.activeRun;
    if (active?.tag !== "current") return ok(null);
    const snapshot = await this.journals.read({
      profileId,
      reviewId,
      journalId: active.journalId,
      runId: active.runId,
    });
    if (snapshot._tag === "err") return err("storage_unavailable");
    const { state } = snapshot.value;
    const status =
      state.status === "queued" || state.status === "preparing"
        ? "queued"
        : state.status === "cancelling" || state.status === "paused"
          ? state.status
          : state.status === "running" || state.status === "waiting"
            ? "running"
            : undefined;
    if (status === undefined) return ok(null);
    let lastRequestHash = null;
    if (status === "paused" && state.dispatches.count > 0) {
      const store = new GuideResultStore(this.artifacts, profileId, reviewId);
      const newest = await store.readIndex(
        "GuideDispatchIntent1",
        state.dispatches,
        state.dispatches.count - 1,
        1,
      );
      const entry = newest._tag === "ok" ? newest.value[0] : undefined;
      const intent =
        entry === undefined
          ? undefined
          : await this.artifacts.readObject(
              profileId,
              reviewId,
              guideDispatchIntentCodec,
              entry.value,
            );
      if (intent?._tag !== "ok") return err("storage_unavailable");
      lastRequestHash = intent.value.requestHash;
    }
    return ok({
      runId: active.runId,
      status,
      generation: state.generation,
      dispatches: state.dispatches.count,
      lastRequestHash,
    });
  }

  private async failureFromSlot(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    slot: InsightSlotRecord3 | undefined,
  ): Promise<Result<GuideSummary["failure"], GuideResultFailure>> {
    if (slot === undefined || slot.replacementFailure === null) return ok(null);
    if (slot.activeRun !== null) return err("invalid_result");
    const failure = await this.artifacts.readObject(
      profileId,
      reviewId,
      insightLegacyFailureCodec,
      slot.replacementFailure,
    );
    if (failure._tag === "err") return err("invalid_result");
    const store = new GuideResultStore(this.artifacts, profileId, reviewId);
    const runId = await store.readText(failure.value.runId, 1_024);
    if (runId._tag === "err" || parseInsightRunId(runId.value)._tag === "err")
      return err("invalid_result");
    const match = /^insight-guide-([1-9]\d*)-[0-9a-f]{12}-(.+)$/.exec(
      runId.value,
    );
    const reviewSegment = reviewId.slice(reviewId.lastIndexOf("__") + 2);
    if (
      match === null ||
      Number(match[1]) !== slot.nextToken - 1 ||
      match[2] !== reviewSegment
    )
      return err("invalid_result");
    let category: NonNullable<GuideSummary["failure"]>["category"] = null;
    if (failure.value.category !== undefined) {
      const text = await store.readText(failure.value.category, 200);
      if (text._tag === "err") return err("invalid_result");
      const parsed = INSIGHT_FAILURE_CATEGORIES.find(
        (candidate) => candidate === text.value,
      );
      if (parsed === undefined) return err("invalid_result");
      category = parsed;
    }
    return ok({
      runId: runId.value,
      reason: failure.value.reason,
      category,
      retryable: failure.value.retryable,
    });
  }

  /** Published session and revision come from the result's Binding, never the displayed Review. */
  async identityOf(
    view: GuideResultView,
  ): Promise<
    Result<
      Pick<Extract<GuideSummary, { _tag: "ready" }>, "sessionId" | "revision">,
      GuideResultFailure
    >
  > {
    const binding = await view.artifacts.readObject(
      view.profileId,
      view.reviewId,
      insightBindingCodec,
      view.root.binding,
    );
    if (binding._tag === "err") return err("invalid_result");
    const identity = await view.artifacts.readObject(
      view.profileId,
      view.reviewId,
      insightDomainIdentityCodec,
      binding.value.identity,
    );
    if (identity._tag === "err") return err("invalid_result");
    const session = await view.store.readText(identity.value.sessionId, 1_024);
    return session._tag === "ok"
      ? ok({
          sessionId: session.value,
          revision: {
            baseSha: binding.value.baseSha,
            headSha: binding.value.headSha,
            patchHash: binding.value.patchHash,
          },
        })
      : err("invalid_result");
  }
}
