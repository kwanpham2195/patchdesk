import { useState } from "react";

import { CompletedReviewWorkbench } from "../components/completed-review-workbench";
import { requestJson } from "../api-client";

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
  const draft = currentWorkbench.draft as { readonly updatedAt?: unknown } | undefined;
  const batch = currentWorkbench.batch as { readonly updatedAt?: unknown } | undefined;

  const refreshRemote = async (): Promise<void> => {
    const value = await requestJson("/v1/reviews/refresh", {
      method: "POST",
      body: { profileId, sessionId },
    });
    if (!isRemoteReviewContext(value)) throw new Error("Review refresh was rejected");
    setRemoteContext(value);
  };

  const saveDraft = async (input: {
    readonly expectedRevision: string;
    readonly summaryBody: string;
    readonly comments: ReadonlyArray<{
      readonly findingId: string;
      readonly include: boolean;
      readonly body: string;
    }>;
  }): Promise<{ readonly draft: never; readonly revision: string }> => {
    const value = await requestJson("/v1/reviews/draft", {
      method: "POST",
      body: { profileId, sessionId, ...input },
    });
    if (!isDraftWrite(value)) throw new Error("Draft save was rejected");
    onWorkbenchPatch({ session: value.session, draft: value.draft });
    return { draft: value.draft as never, revision: value.revision };
  };

  const reviewWrite = async (
    path: "/v1/reviews/pending" | "/v1/reviews/submit" | "/v1/reviews/apply-batch",
    extra: Record<string, unknown> = {},
  ): Promise<{ readonly reviewId: string }> => {
    const revision = typeof batch?.updatedAt === "string" ? batch.updatedAt : draft?.updatedAt;
    if (typeof revision !== "string") {
      throw new Error("The saved draft revision is unavailable");
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
        draft: currentWorkbench.draft as never,
        ...(currentWorkbench.batch === undefined ? {} : { batch: currentWorkbench.batch as never }),
        comments: currentWorkbench.comments as never,
        checks: currentWorkbench.checks as never,
        history: (currentWorkbench.history as never) ?? [],
        ...(currentWorkbench.mergeReadiness === undefined ? {} : { mergeReadiness: currentWorkbench.mergeReadiness as never }),
      }}
      actions={{
        saveDraft,
        createPendingReview: async () => reviewWrite("/v1/reviews/pending"),
        submitPendingReview: async (event) => reviewWrite("/v1/reviews/submit", { event }),
        refreshRemote,
        merge,
        reportNavigationState: onNavigationStateChange,
      }}
    />
  );
}

function isDraftWrite(value: unknown): value is {
  readonly session: unknown;
  readonly draft: unknown;
  readonly revision: string;
} {
  return isRecord(value) && isRecord(value.session) && isRecord(value.draft) && typeof value.revision === "string";
}

function isReviewWrite(value: unknown): value is {
  readonly session: unknown;
  readonly draft?: { readonly state: unknown };
  readonly batch?: { readonly state: unknown };
} {
  return isRecord(value) && isRecord(value.session) && ((isRecord(value.draft) && "state" in value.draft) || (isRecord(value.batch) && "state" in value.batch));
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
