import { readdir } from "node:fs/promises";
import type * as v from "valibot";
import { InsightArtifactStore } from "#src/adapters/storage/insight-artifact-store";
import { InsightResultStore } from "#src/adapters/storage/insight-result-store";
import { InsightRunJournalReader } from "#src/adapters/storage/insight-run-journal-reader";
import { InsightSlotStore } from "#src/adapters/storage/insight-slot-store";
import type { readBoundedInsightArtifactFile } from "#src/adapters/storage/insight-artifact-files";
import type { StorageFailure } from "#src/adapters/storage/json-file";
import type { PatchdeskPaths } from "#src/adapters/storage/patchdesk-paths";
import type { ReviewId, WorkspaceProfileId } from "#src/domain/ids";
import type { InsightSlotRecord3 } from "#src/domain/insight-slot-contract";
import {
  encodeInsightArtifactCanonicalJson,
  type InsightArtifactReference,
} from "#src/domain/insight-artifact-scalars";
import {
  insightAuthorizationCodec,
  insightBindingCodec,
  insightDomainIdentityCodec,
  insightLegacyFailureCodec,
  insightProvenanceCodec,
} from "#src/domain/insight-run-binding-contract";
import { INSIGHT_FAILURE_CATEGORIES } from "#src/domain/insight-record";
import {
  walkthroughDispatchIntentCodec,
  walkthroughPublicationCodec,
  walkthroughResultRootCodec,
  walkthroughRuntimeCodec,
  walkthroughValidationCodec,
} from "#src/domain/walkthrough-result";
import type {
  WalkthroughReadFailure,
  WalkthroughSummary,
} from "#src/domain/walkthrough-progress";
import type { GuideRunStatus } from "#src/domain/guide-progress";
import { err, ok, type Result } from "#src/domain/result";
import type { AppLogService } from "./app-log-service";

/** One strictly selected root and the bounded storage capabilities its pages need. */
export type WalkthroughResultView = {
  readonly profileId: WorkspaceProfileId;
  readonly reviewId: ReviewId;
  readonly digest: InsightArtifactReference["hash"];
  readonly runId: string;
  readonly root: v.InferOutput<typeof walkthroughResultRootCodec.schema>;
  readonly store: InsightResultStore;
  readonly artifacts: InsightArtifactStore;
  readonly metadata: Pick<
    Extract<WalkthroughSummary, { _tag: "ready" }>,
    "sessionId" | "revision" | "generatedAt" | "provenance"
  >;
};

/** Invalid bytes are 422; an I/O failure is 503 and must never become absence. */
export function walkthroughReadFailure(
  error: StorageFailure,
): WalkthroughReadFailure {
  return error.reason === "invalid_stored_value" || error.reason === "not_found"
    ? "invalid_result"
    : "storage_unavailable";
}

/** Selects only WalkthroughResultRoot1. Historical retained bytes are preserved but never reconstructed. */
export class WalkthroughResultReader {
  private readonly slots: InsightSlotStore;
  private readonly artifacts: InsightArtifactStore;
  private readonly journals: InsightRunJournalReader;

  constructor(
    private readonly paths: PatchdeskPaths,
    reader: typeof readBoundedInsightArtifactFile,
    private readonly logs?: Pick<AppLogService, "write">,
  ) {
    this.slots = new InsightSlotStore(paths, reader);
    this.artifacts = new InsightArtifactStore(paths, reader);
    this.journals = new InsightRunJournalReader(paths, this.artifacts, reader);
  }

  /** Current means the retained pointer, not necessarily the workbench's latest revision. */
  async current(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<
    Result<WalkthroughResultView | undefined, WalkthroughReadFailure>
  > {
    const slot = await this.slots.read(profileId, reviewId, "walkthrough");
    return slot._tag === "err"
      ? err(walkthroughReadFailure(slot.error))
      : this.published(profileId, reviewId, slot.value);
  }

  /** Selects retained data, active run and replacement failure from one slot snapshot. */
  async summarySource(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
  ): Promise<
    Result<
      {
        readonly view: WalkthroughResultView | undefined;
        readonly run: GuideRunStatus;
        readonly failure: WalkthroughSummary["failure"];
      },
      WalkthroughReadFailure
    >
  > {
    const slot = await this.slots.read(profileId, reviewId, "walkthrough");
    if (slot._tag === "err") return err(walkthroughReadFailure(slot.error));
    if (slot.value?.retained?.tag === "historical") return err("not_available");
    const view = await this.published(profileId, reviewId, slot.value);
    if (view._tag === "err") return view;
    const run = await this.active(profileId, reviewId, slot.value);
    if (run._tag === "err") return run;
    const failure = await this.failure(profileId, reviewId, slot.value);
    if (failure._tag === "err") return failure;
    if (failure.value !== null && failure.value.runId === view.value?.runId)
      return err("invalid_result");
    return ok({ view: view.value, run: run.value, failure: failure.value });
  }

  private async published(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    slot: InsightSlotRecord3 | undefined,
  ): Promise<
    Result<WalkthroughResultView | undefined, WalkthroughReadFailure>
  > {
    if (slot?.retained?.tag !== "generated" || slot.publication === null)
      return ok(undefined);
    // Each request uses one read lease so concurrent UI requests share the four-read quota.
    const root = await this.artifacts.readObject(
      profileId,
      reviewId,
      walkthroughResultRootCodec,
      slot.retained.root,
    );
    if (root._tag === "err") return err(walkthroughReadFailure(root.error));
    const publication = await this.artifacts.readObject(
      profileId,
      reviewId,
      walkthroughPublicationCodec,
      slot.publication,
    );
    if (publication._tag === "err")
      return err(walkthroughReadFailure(publication.error));
    const pub = publication.value;
    if (
      !same(pub.result, slot.retained.root) ||
      !same(pub.validation, root.value.validation) ||
      !same(pub.receipts, root.value.receipts) ||
      pub.frozenSequence !== root.value.frozenSequence ||
      root.value.citedHunks + root.value.uncited.count !==
        root.value.hunks.count ||
      root.value.sections.count < 1 ||
      root.value.chapters.count < 1
    )
      return err("invalid_result");
    const binding = await this.artifacts.readObject(
      profileId,
      reviewId,
      insightBindingCodec,
      root.value.binding,
    );
    if (binding._tag === "err")
      return err(walkthroughReadFailure(binding.error));
    const validation = await this.artifacts.readObject(
      profileId,
      reviewId,
      walkthroughValidationCodec,
      root.value.validation,
    );
    if (validation._tag === "err")
      return err(walkthroughReadFailure(validation.error));
    const {
      generation,
      cancelEpoch,
      validator: _validator,
      ...graph
    } = validation.value;
    const { validation: _validation, ...rootGraph } = root.value;
    if (
      binding.value.kind !== "walkthrough" ||
      generation !== pub.generation ||
      cancelEpoch !== pub.cancelEpoch ||
      !same(graph, rootGraph)
    )
      return err("invalid_result");
    const store = new InsightResultStore(this.artifacts, profileId, reviewId);
    const identity = await this.artifacts.readObject(
      profileId,
      reviewId,
      insightDomainIdentityCodec,
      binding.value.identity,
    );
    if (identity._tag === "err")
      return err(walkthroughReadFailure(identity.error));
    const identities = [];
    for (const text of [
      identity.value.profileId,
      identity.value.reviewId,
      identity.value.runId,
      identity.value.sessionId,
    ]) {
      const value = await store.readText(text, 4096);
      if (value._tag === "err") return err(walkthroughReadFailure(value.error));
      identities.push(value);
    }
    const [profile, review, run, session] = identities;
    if (
      profile?._tag !== "ok" ||
      review?._tag !== "ok" ||
      run?._tag !== "ok" ||
      session?._tag !== "ok" ||
      profile.value !== profileId ||
      review.value !== reviewId ||
      run.value !== pub.runId
    )
      return err("invalid_result");
    const authorization = await this.authorization(
      profileId,
      reviewId,
      pub,
      root.value.binding,
    );
    if (authorization._tag === "err") return authorization;
    const provenance = await this.artifacts.readObject(
      profileId,
      reviewId,
      insightProvenanceCodec,
      authorization.value.selection,
    );
    if (provenance._tag === "err")
      return err(walkthroughReadFailure(provenance.error));
    if (
      provenance.value.provider !== "pi" ||
      provenance.value.origin !== "generated"
    )
      return err("invalid_result");
    const model = await store.readText(provenance.value.model, 4096);
    if (model._tag === "err") return err(walkthroughReadFailure(model.error));
    return ok({
      profileId,
      reviewId,
      digest: slot.retained.root.hash,
      runId: pub.runId,
      root: root.value,
      store,
      artifacts: this.artifacts,
      metadata: {
        sessionId: session.value,
        revision: {
          baseSha: binding.value.baseSha,
          headSha: binding.value.headSha,
          patchHash: binding.value.patchHash,
        },
        generatedAt: pub.publishedAt,
        provenance: {
          provider: "pi",
          model: model.value,
          language: provenance.value.language,
        },
      },
    });
  }

  private async authorization(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    publication: v.InferOutput<typeof walkthroughPublicationCodec.schema>,
    binding: InsightArtifactReference,
  ): Promise<
    Result<
      v.InferOutput<typeof insightAuthorizationCodec.schema>,
      WalkthroughReadFailure
    >
  > {
    let names: string[];
    try {
      names = await readdir(
        this.paths.insightJournalsDirectory(profileId, reviewId),
      );
    } catch {
      this.logs?.write({
        process: "main",
        level: "warn",
        topic: "insight-artifact-read",
        message: "Walkthrough provenance read failed",
        meta: { category: "journal_directory_io" },
      });
      return err("storage_unavailable");
    }
    for (const name of names) {
      if (
        !this.paths.isInsightJournalEntryName(name) ||
        name.endsWith(".intent.json")
      )
        continue;
      const journal = await this.journals.read({
        profileId,
        reviewId,
        journalId: name.slice(0, -5),
        runId: publication.runId,
      });
      // Other runs fail the journal reader's exact run-ID comparison.
      if (journal._tag === "err") {
        if (journal.error.reason !== "invalid_stored_value")
          return err(walkthroughReadFailure(journal.error));
        continue;
      }
      const state = journal.value.state;
      if (
        !same(state.binding, binding) ||
        state.generation !== publication.generation ||
        state.cancelEpoch !== publication.cancelEpoch ||
        state.walkthroughRuntime === undefined ||
        (state.status !== "complete" && state.status !== "running")
      )
        return err("invalid_result");
      const runtime = await this.artifacts.readObject(
        profileId,
        reviewId,
        walkthroughRuntimeCodec,
        state.walkthroughRuntime,
      );
      if (runtime._tag === "err")
        return err(walkthroughReadFailure(runtime.error));
      if (
        runtime.value.phase !== "validated" ||
        !same(runtime.value.result, publication.result) ||
        runtime.value.frozen?.sequence !== publication.frozenSequence ||
        !same(runtime.value.receipts, publication.receipts) ||
        !same(runtime.value.frozen.receipts, publication.receipts)
      )
        return err("invalid_result");
      const authorization = await this.artifacts.readObject(
        profileId,
        reviewId,
        insightAuthorizationCodec,
        state.authorization,
      );
      if (authorization._tag === "err")
        return err(walkthroughReadFailure(authorization.error));
      return authorization.value.runId === publication.runId &&
        same(authorization.value.policy, state.policy)
        ? authorization
        : err("invalid_result");
    }
    return err("invalid_result");
  }

  private async active(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    slot: InsightSlotRecord3 | undefined,
  ): Promise<Result<GuideRunStatus, WalkthroughReadFailure>> {
    if (slot?.activeRun?.tag !== "current") return ok(null);
    const active = slot.activeRun;
    const journal = await this.journals.read({
      profileId,
      reviewId,
      journalId: active.journalId,
      runId: active.runId,
    });
    if (journal._tag === "err")
      return err(walkthroughReadFailure(journal.error));
    const state = journal.value.state;
    const status =
      state.status === "queued" || state.status === "preparing"
        ? "queued"
        : state.status === "running" || state.status === "waiting"
          ? "running"
          : state.status === "paused" || state.status === "cancelling"
            ? state.status
            : null;
    if (status === null) return ok(null);
    let lastRequestHash = null;
    if (status === "paused" && state.dispatches.count > 0) {
      const store = new InsightResultStore(this.artifacts, profileId, reviewId);
      const last = await store.readIndex(
        "WalkthroughDispatchIntent1",
        state.dispatches,
        state.dispatches.count - 1,
        1,
      );
      if (last._tag === "err") return err(walkthroughReadFailure(last.error));
      const entry = last.value[0];
      if (entry === undefined) return err("invalid_result");
      const intent = await this.artifacts.readObject(
        profileId,
        reviewId,
        walkthroughDispatchIntentCodec,
        entry.value,
      );
      if (intent._tag === "err")
        return err(walkthroughReadFailure(intent.error));
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

  private async failure(
    profileId: WorkspaceProfileId,
    reviewId: ReviewId,
    slot: InsightSlotRecord3 | undefined,
  ): Promise<Result<WalkthroughSummary["failure"], WalkthroughReadFailure>> {
    if (
      slot?.replacementFailure === undefined ||
      slot.replacementFailure === null
    )
      return ok(null);
    if (slot.activeRun !== null) return err("invalid_result");
    const failure = await this.artifacts.readObject(
      profileId,
      reviewId,
      insightLegacyFailureCodec,
      slot.replacementFailure,
    );
    if (failure._tag === "err")
      return err(walkthroughReadFailure(failure.error));
    const store = new InsightResultStore(this.artifacts, profileId, reviewId);
    const run = await store.readText(failure.value.runId, 4096);
    if (run._tag === "err") return err(walkthroughReadFailure(run.error));
    const match = /^insight-walkthrough-([1-9]\d*)-[0-9a-f]{12}-(.+)$/.exec(
      run.value,
    );
    if (
      match === null ||
      Number(match[1]) !== slot.nextToken - 1 ||
      match[2] !== reviewId.slice(reviewId.lastIndexOf("__") + 2)
    )
      return err("invalid_result");
    let category: NonNullable<WalkthroughSummary["failure"]>["category"] = null;
    if (failure.value.category !== undefined) {
      const text = await store.readText(failure.value.category, 200);
      if (text._tag === "err") return err(walkthroughReadFailure(text.error));
      const found = INSIGHT_FAILURE_CATEGORIES.find(
        (value) => value === text.value,
      );
      if (found === undefined) return err("invalid_result");
      category = found;
    }
    return ok({
      runId: run.value,
      reason: failure.value.reason,
      category,
      retryable: failure.value.retryable,
    });
  }
}

function same(
  left: Parameters<typeof encodeInsightArtifactCanonicalJson>[0],
  right: Parameters<typeof encodeInsightArtifactCanonicalJson>[0],
): boolean {
  return (
    encodeInsightArtifactCanonicalJson(left) ===
    encodeInsightArtifactCanonicalJson(right)
  );
}
