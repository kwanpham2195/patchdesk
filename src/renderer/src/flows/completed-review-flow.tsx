import { useState } from "react";

import { CompletedReviewWorkbench } from "../components/completed-review-workbench";
import { requestJson } from "../api-client";
import { useWalkthroughController } from "../hooks/use-walkthrough-controller";
import { parseWorkbenchResponse } from "../renderer-contracts";
import { reviewIdForSession } from "../review-identity";

export type CompletedReviewFlowWorkbench = {
  readonly state: "completed";
  readonly review?: { readonly id: string; readonly status: "open" | "merged" | "closed" };
  readonly session: {
    readonly id: string;
    readonly key: {
      readonly profileId: string;
      readonly host?: string;
      readonly owner?: string;
      readonly repo?: string;
      readonly prNumber?: number;
    };
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
  readonly batch?: unknown;
  readonly comments?: unknown;
  readonly checks?: unknown;
  readonly history?: unknown;
  readonly mergeReadiness?: unknown;
};

export type CompletedReviewFlowProps = {
  readonly workbench: CompletedReviewFlowWorkbench;
  readonly onWorkbenchPatch: (patch: {
    readonly session?: unknown;
    readonly batch?: unknown;
  }) => void;
  readonly onWorkbenchReplace?: (workbench: unknown) => void;
  readonly onNavigationStateChange: (
    state: "clear" | "dirty_draft" | "write_pending",
  ) => void;
};

/** Owns completed-review API calls and passes one model/action boundary to the interaction surface. */
export function CompletedReviewFlow({
  workbench,
  onWorkbenchPatch,
  onWorkbenchReplace,
  onNavigationStateChange,
}: CompletedReviewFlowProps): React.JSX.Element {
  const [remoteContext, setRemoteContext] = useState<
    Partial<CompletedReviewFlowWorkbench>
  >({});
  const currentWorkbench = { ...workbench, ...remoteContext };
  const profileId = currentWorkbench.session.key.profileId;
  const reviewId = currentWorkbench.review?.id ?? reviewIdForSession(currentWorkbench.session.key);
  const sessionId = currentWorkbench.session.id;
  const batch = currentWorkbench.batch as
    { readonly updatedAt?: unknown } | undefined;

  const walkthrough = useWalkthroughController({
    profileId,
    sessionId,
    headSha: currentWorkbench.reviewedHeadSha ?? "",
  });

  const refreshRemote = async (): Promise<void> => {
    if (reviewId === undefined) throw new Error("Stable review identity is unavailable");
    const value = await requestJson("/v1/reviews/refresh", {
      method: "POST",
      body: { profileId, reviewId },
    });
    const refreshed = parseWorkbenchResponse(value);
    if (refreshed === undefined) throw new Error("Review refresh was rejected");
    if (onWorkbenchReplace !== undefined) {
      onWorkbenchReplace(refreshed);
      return;
    }
    setRemoteContext({
      ...(refreshed.pullRequest === undefined ? {} : { pullRequest: refreshed.pullRequest }),
      ...(refreshed.revision.currentHeadSha === undefined ? {} : { currentHeadSha: refreshed.revision.currentHeadSha }),
      freshness: refreshed.revision.freshness,
      refreshedAt: refreshed.revision.refreshedAt,
      comments: refreshed.comments,
      checks: refreshed.checks,
      mergeReadiness: refreshed.mergeReadiness,
    });
  };

  const reviewWrite = async (
    path: "/v1/reviews/apply-batch" | "/v1/reviews/submit-batch",
    extra: Record<string, unknown> = {},
  ): Promise<{ readonly reviewId: string }> => {
    const revision =
      typeof batch?.updatedAt === "string" ? batch.updatedAt : undefined;
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
    onWorkbenchPatch({
      session: value.session,
      ...(value.batch === undefined ? {} : { batch: value.batch }),
    });
    if (value.batch === undefined)
      throw new Error("Review write returned no batch");
    const state = value.batch.state as { readonly reviewId?: unknown };
    return {
      reviewId: typeof state.reviewId === "string" ? state.reviewId : "review",
    };
  };

  const updateBatch = async (
    command: Record<string, unknown>,
  ): Promise<void> => {
    const current = currentWorkbench.batch as
      { readonly updatedAt?: unknown } | undefined;
    if (typeof current?.updatedAt !== "string")
      throw new Error("The saved review batch is unavailable");
    const value = await requestJson("/v1/reviews/batch", {
      method: "POST",
      body: {
        profileId,
        sessionId,
        expectedRevision: current.updatedAt,
        command,
      },
    });
    if (!isBatchUpdate(value))
      throw new Error("Review batch update was rejected");
    onWorkbenchPatch({
      session: value.session,
      ...(value.batch === undefined ? {} : { batch: value.batch }),
    });
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
        ...(currentWorkbench.fullPatch === undefined
          ? {}
          : { fullPatch: currentWorkbench.fullPatch }),
        ...(currentWorkbench.comparison === undefined
          ? {}
          : { comparison: currentWorkbench.comparison as never }),
        ...(currentWorkbench.comparisonPatch === undefined
          ? {}
          : { comparisonPatch: currentWorkbench.comparisonPatch }),
        ...(currentWorkbench.lifecycle === undefined
          ? {}
          : { lifecycle: currentWorkbench.lifecycle as never }),
        comparisonAvailability:
          currentWorkbench.comparisonAvailability as never,
        ...(currentWorkbench.pullRequest === undefined
          ? {}
          : { pullRequest: currentWorkbench.pullRequest as never }),
        reviewedHeadSha: currentWorkbench.reviewedHeadSha as never,
        ...(currentWorkbench.currentHeadSha === undefined
          ? {}
          : { currentHeadSha: currentWorkbench.currentHeadSha }),
        freshness: currentWorkbench.freshness as never,
        refreshedAt: currentWorkbench.refreshedAt as never,
        ...(currentWorkbench.batch === undefined
          ? {}
          : { batch: currentWorkbench.batch as never }),
        comments: currentWorkbench.comments as never,
        checks: currentWorkbench.checks as never,
        ...(currentWorkbench.mergeReadiness === undefined
          ? {}
          : { mergeReadiness: currentWorkbench.mergeReadiness as never }),
      }}
      actions={{
        batchActions: {
          addInlineComment: async ({ path, startLine, line, side, fingerprint, body }) =>
            updateBatch({
              _tag: "AddInlineComment",
              anchor: { path, startLine, line, side },
              ...(fingerprint === undefined ? {} : { fingerprint }),
              body,
            }),
          removeItem: async (itemId) =>
            updateBatch({ _tag: "RemoveItem", itemId }),
          addThreadReply: async (threadId, body) =>
            updateBatch({ _tag: "AddThreadReply", threadId, body }),
          setThreadState: async (threadId, action) =>
            updateBatch({ _tag: "SetThreadState", threadId, action }),
          apply: async () => {
            await reviewWrite("/v1/reviews/apply-batch");
          },
          submit: async (event) => {
            await reviewWrite("/v1/reviews/submit-batch", { event });
          },
        },
        refreshRemote,
        merge,
        reportNavigationState: onNavigationStateChange,
        walkthrough,
      }}
    />
  );
}

function isReviewWrite(value: unknown): value is {
  readonly session: unknown;
  readonly batch?: { readonly state: unknown };
} {
  return (
    isRecord(value) &&
    isRecord(value.session) &&
    isRecord(value.batch) &&
    "state" in value.batch
  );
}

function isBatchUpdate(
  value: unknown,
): value is { readonly session: unknown; readonly batch?: unknown } {
  return (
    isRecord(value) &&
    isRecord(value.session) &&
    (value.batch === undefined || isRecord(value.batch))
  );
}

function isMergeWrite(value: unknown): value is {
  readonly session: {
    readonly mergeDecision?: { readonly mergeCommitSha?: unknown };
  };
} {
  return isRecord(value) && isRecord(value.session);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
