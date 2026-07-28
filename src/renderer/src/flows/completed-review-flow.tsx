import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CompletedReviewWorkbench } from "../components/completed-review-workbench";
import { requestJson } from "../api-client";
import { parseModelCatalog, parseWalkthroughProjection, type ModelCatalog, type WalkthroughProjection } from "../renderer-contracts";
import {
  loadReviewExecutionPreference,
  saveReviewExecutionPreference,
  type ReviewReasoningPreference,
} from "../review-execution-preferences";

export type CompletedReviewFlowWorkbench = {
  readonly state: "completed";
  readonly session: {
    readonly id: string;
    readonly key: { readonly profileId: string };
  };
  readonly result?: unknown;
  readonly reviewScope?: unknown;
  readonly fullPatch?: string;
  readonly comparison?: unknown;
  readonly comparisonPatch?: string;
  readonly lifecycle?: unknown;
  readonly comparisonAvailability?: unknown;
  readonly pullRequest?: unknown;
  readonly reviewedHeadSha?: string;
  readonly currentHeadSha?: string;
  readonly freshness?: unknown;
  readonly refreshedAt?: string;
  readonly draft?: unknown;
  readonly batch?: unknown;
  readonly comments?: unknown;
  readonly checks?: unknown;
  readonly history?: unknown;
  readonly mergeReadiness?: unknown;
};

export type CompletedReviewFlowProps = {
  readonly workbench: CompletedReviewFlowWorkbench;
  readonly onWorkbenchPatch: (patch: { readonly session?: unknown; readonly draft?: unknown; readonly batch?: unknown }) => void;
  readonly onNavigationStateChange: (state: "clear" | "dirty_draft" | "write_pending") => void;
};

/** Owns completed-review API calls and passes one model/action boundary to the interaction surface. */
export function CompletedReviewFlow({
  workbench,
  onWorkbenchPatch,
  onNavigationStateChange,
}: CompletedReviewFlowProps): React.JSX.Element {
  const [remoteContext, setRemoteContext] = useState<Partial<CompletedReviewFlowWorkbench>>({});
  const currentWorkbench = { ...workbench, ...remoteContext };
  const profileId = currentWorkbench.session.key.profileId;
  const sessionId = currentWorkbench.session.id;
  const batch = currentWorkbench.batch as { readonly updatedAt?: unknown } | undefined;
  const reviewedHeadSha = currentWorkbench.reviewedHeadSha;

  const [walkthroughDialogOpen, setWalkthroughDialogOpen] = useState(false);
  const [walkthroughProjection, setWalkthroughProjection] = useState<WalkthroughProjection>({ lifecycle: "idle", noticeKey: "walkthrough-idle" });
  const [walkthroughBusy, setWalkthroughBusy] = useState(false);
  const [walkthroughModels, setWalkthroughModels] = useState<ReadonlyArray<{ readonly id: string; readonly label: string }>>([]);
  const [walkthroughModel, setWalkthroughModel] = useState<string>();
  const [walkthroughReasoning, setWalkthroughReasoning] = useState<ReviewReasoningPreference>("medium");
  const [walkthroughCatalogUnavailable, setWalkthroughCatalogUnavailable] = useState(false);
  const mountedSessionRef = useRef(sessionId);
  useEffect(() => { mountedSessionRef.current = sessionId; }, [sessionId]);

  // Load the active Pi catalog once per mounted session; restore a valid per-profile
  // preference and never block the workbench on a missing catalog.
  useEffect(() => {
    let active = true;
    void requestJson("/v1/reviews/models")
      .then((value) => {
        if (!active) return;
        const catalog: ModelCatalog | undefined = parseModelCatalog(value);
        if (catalog === undefined) {
          setWalkthroughModels([]);
          setWalkthroughModel(undefined);
          setWalkthroughCatalogUnavailable(true);
          return;
        }
        const saved = loadReviewExecutionPreference(profileId);
        const restored = saved?.model !== undefined && catalog.models.some((model) => model.id === saved.model)
          ? saved.model
          : catalog.defaultModel !== undefined && catalog.models.some((model) => model.id === catalog.defaultModel)
            ? catalog.defaultModel
            : catalog.models[0]?.id;
        setWalkthroughModels(catalog.models);
        setWalkthroughModel(restored);
        setWalkthroughReasoning(saved?.reasoning ?? "medium");
        setWalkthroughCatalogUnavailable(false);
      })
      .catch(() => {
        if (!active) return;
        setWalkthroughModels([]);
        setWalkthroughModel(undefined);
        setWalkthroughCatalogUnavailable(true);
      });
    return () => { active = false; };
  }, [profileId]);

  const openWalkthroughDialog = useCallback(() => {
    setWalkthroughDialogOpen(true);
  }, []);
  const closeWalkthroughDialog = useCallback(() => {
    setWalkthroughDialogOpen(false);
  }, []);

  const submitWalkthrough = useCallback(async () => {
    if (walkthroughModel === undefined) return;
    const snapshot = mountedSessionRef.current;
    const request = {
      profileId,
      sessionId: snapshot,
      model: walkthroughModel,
      reasoning: walkthroughReasoning,
    } as const;
    saveReviewExecutionPreference(profileId, { model: walkthroughModel, reasoning: walkthroughReasoning });
    setWalkthroughBusy(true);
    try {
      const value = await requestJson("/v1/reviews/walkthrough/generate", { method: "POST", body: request });
      if (mountedSessionRef.current !== snapshot) return;
      const parsed = parseWalkthroughProjection(value);
      if (parsed === undefined) {
        setWalkthroughProjection({ lifecycle: "failed", noticeKey: "walkthrough-failed", actionKey: "walkthrough-retry" });
      } else {
        setWalkthroughProjection(parsed);
        if (parsed.lifecycle === "ready" || parsed.lifecycle === "failed" || parsed.lifecycle === "stale") {
          setWalkthroughDialogOpen(false);
        }
      }
    } catch {
      if (mountedSessionRef.current !== snapshot) return;
      setWalkthroughProjection({ lifecycle: "failed", noticeKey: "walkthrough-failed", actionKey: "walkthrough-retry" });
    } finally {
      if (mountedSessionRef.current === snapshot) setWalkthroughBusy(false);
    }
  }, [profileId, walkthroughModel, walkthroughReasoning]);

  const retryWalkthrough = useCallback(async () => {
    if (walkthroughModel === undefined) {
      setWalkthroughDialogOpen(true);
      return;
    }
    await submitWalkthrough();
  }, [submitWalkthrough, walkthroughModel]);

  const regenerateWalkthrough = useCallback(() => {
    setWalkthroughDialogOpen(true);
  }, []);

  const walkthroughActions = useMemo(() => ({
    dialogOpen: walkthroughDialogOpen,
    projection: walkthroughProjection,
    models: walkthroughModels,
    model: walkthroughModel,
    reasoning: walkthroughReasoning,
    catalogUnavailable: walkthroughCatalogUnavailable,
    onOpenDialog: openWalkthroughDialog,
    onCloseDialog: closeWalkthroughDialog,
    onModelChange: (model: string) => setWalkthroughModel(model),
    onReasoningChange: (reasoning: ReviewReasoningPreference) => setWalkthroughReasoning(reasoning),
    onConfirm: () => { void submitWalkthrough(); },
    onRetry: () => { void retryWalkthrough(); },
    onRegenerate: regenerateWalkthrough,
    busy: walkthroughBusy,
  }), [
    closeWalkthroughDialog, openWalkthroughDialog, regenerateWalkthrough, retryWalkthrough, submitWalkthrough,
    walkthroughBusy, walkthroughCatalogUnavailable, walkthroughDialogOpen, walkthroughModel, walkthroughModels,
    walkthroughProjection, walkthroughReasoning,
  ]);

  void reviewedHeadSha;

  const refreshRemote = async (): Promise<void> => {
    const value = await requestJson("/v1/reviews/refresh", {
      method: "POST",
      body: { profileId, sessionId },
    });
    if (!isRemoteReviewContext(value)) throw new Error("Review refresh was rejected");
    setRemoteContext(value);
  };

  const reviewWrite = async (
    path: "/v1/reviews/pending" | "/v1/reviews/submit" | "/v1/reviews/apply-batch",
    extra: Record<string, unknown> = {},
  ): Promise<{ readonly reviewId: string }> => {
    const revision = typeof batch?.updatedAt === "string" ? batch.updatedAt : undefined;
    if (typeof revision !== "string") {
      throw new Error("The saved review batch revision is unavailable");
    }
    const value = await requestJson(path, {
      method: "POST",
      body: {
        profileId,
        sessionId,
        expectedRevision: revision,
        acknowledgement: true,
        ...extra,
      },
    });
    if (!isReviewWrite(value)) throw new Error("Review write was rejected");
    onWorkbenchPatch({ session: value.session, ...(value.draft === undefined ? {} : { draft: value.draft }), ...(value.batch === undefined ? {} : { batch: value.batch }) });
    const writeModel = value.batch ?? value.draft;
    if (writeModel === undefined) throw new Error("Review write returned no batch");
    const state = writeModel.state as { readonly pendingReviewId?: unknown; readonly reviewId?: unknown };
    return {
      reviewId:
        typeof state.reviewId === "string"
          ? state.reviewId
          : typeof state.pendingReviewId === "string"
            ? state.pendingReviewId
            : "review",
    };
  };

  const updateBatch = async (command: Record<string, unknown>): Promise<void> => {
    const current = currentWorkbench.batch as { readonly attemptId?: unknown; readonly updatedAt?: unknown } | undefined;
    if (typeof current?.attemptId !== "string" || typeof current.updatedAt !== "string") throw new Error("The saved review batch is unavailable");
    const value = await requestJson("/v1/reviews/batch", {
      method: "POST",
      body: { profileId, sessionId, attemptId: current.attemptId, expectedRevision: current.updatedAt, command },
    });
    if (!isBatchUpdate(value)) throw new Error("Review batch update was rejected");
    onWorkbenchPatch({ session: value.session, ...(value.batch === undefined ? {} : { batch: value.batch }) });
  };

  const merge = async (
    method: "merge" | "squash" | "rebase",
    acknowledgedWarnings: boolean,
  ): Promise<{ readonly mergeCommitSha?: string }> => {
    const value = await requestJson("/v1/reviews/merge", {
      method: "POST",
      body: { profileId, sessionId, method, acknowledgedWarnings },
    });
    if (!isMergeWrite(value)) throw new Error("Merge was rejected");
    onWorkbenchPatch({ session: value.session });
    const decision = value.session.mergeDecision;
    return typeof decision?.mergeCommitSha === "string"
      ? { mergeCommitSha: decision.mergeCommitSha }
      : {};
  };

  return (
    <CompletedReviewWorkbench
      model={{
        source: { profileId, sessionId },
        result: currentWorkbench.result as never,
        reviewScope: currentWorkbench.reviewScope as never,
        ...(currentWorkbench.fullPatch === undefined ? {} : { fullPatch: currentWorkbench.fullPatch }),
        ...(currentWorkbench.comparison === undefined ? {} : { comparison: currentWorkbench.comparison as never }),
        ...(currentWorkbench.comparisonPatch === undefined ? {} : { comparisonPatch: currentWorkbench.comparisonPatch }),
        ...(currentWorkbench.lifecycle === undefined ? {} : { lifecycle: currentWorkbench.lifecycle as never }),
        comparisonAvailability: currentWorkbench.comparisonAvailability as never,
        ...(currentWorkbench.pullRequest === undefined ? {} : { pullRequest: currentWorkbench.pullRequest as never }),
        reviewedHeadSha: currentWorkbench.reviewedHeadSha as never,
        ...(currentWorkbench.currentHeadSha === undefined ? {} : { currentHeadSha: currentWorkbench.currentHeadSha }),
        freshness: currentWorkbench.freshness as never,
        refreshedAt: currentWorkbench.refreshedAt as never,
        ...(currentWorkbench.batch === undefined ? {} : { batch: currentWorkbench.batch as never }),
        comments: currentWorkbench.comments as never,
        checks: currentWorkbench.checks as never,
        ...(currentWorkbench.mergeReadiness === undefined ? {} : { mergeReadiness: currentWorkbench.mergeReadiness as never }),
      }}
      actions={{
        batchActions: {
          addInlineComment: async ({ path, startLine, line, side, body }) => updateBatch({ _tag: "AddInlineComment", anchor: { path, startLine, line, side }, body }),
          removeItem: async (itemId) => updateBatch({ _tag: "RemoveItem", itemId }),
          addThreadReply: async (threadId, body) => updateBatch({ _tag: "AddThreadReply", threadId, body }),
          setThreadState: async (threadId, action) => updateBatch({ _tag: "SetThreadState", threadId, action }),
          apply: async () => { await reviewWrite("/v1/reviews/apply-batch"); },
        },
        refreshRemote,
        merge,
        reportNavigationState: onNavigationStateChange,
        walkthrough: walkthroughActions,
      }}
    />
  );
}

function isReviewWrite(value: unknown): value is {
  readonly session: unknown;
  readonly draft?: { readonly state: unknown };
  readonly batch?: { readonly state: unknown };
} {
  return isRecord(value) && isRecord(value.session) && ((isRecord(value.draft) && "state" in value.draft) || (isRecord(value.batch) && "state" in value.batch));
}

function isBatchUpdate(value: unknown): value is { readonly session: unknown; readonly batch?: unknown } {
  return isRecord(value) && isRecord(value.session) && (value.batch === undefined || isRecord(value.batch));
}

function isMergeWrite(value: unknown): value is {
  readonly session: { readonly mergeDecision?: { readonly mergeCommitSha?: unknown } };
} {
  return isRecord(value) && isRecord(value.session);
}

function isRemoteReviewContext(value: unknown): value is Partial<CompletedReviewFlowWorkbench> {
  return isRecord(value) && typeof value.freshness === "string" && typeof value.refreshedAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
