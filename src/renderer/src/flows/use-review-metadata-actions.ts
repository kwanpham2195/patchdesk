import { useCallback } from "react";

import type { RecentReviewWrite } from "../../../domain/recent-review-write";
import {
  PatchdeskApiError,
  isOutcomeUnknownRetry,
  requestJson,
  untrustedWriteResponseError,
} from "../api-client";
import {
  parseAssignableUserListResponse,
  parseRepositoryLabelListResponse,
  parseReviewerListResponse,
  type AssignableUserListResponse,
  type RemoteWriteRecovery,
  type RepositoryLabelListResponse,
  type ReviewerListResponse,
  type WorkbenchResponse,
} from "../renderer-contracts";
import {
  parseBaseBranchListResponse,
  type BaseBranchListResponse,
} from "../base-branch-contracts";
import {
  parseAssigneeReceipt,
  parseBaseBranchReceipt,
  parseDraftStateReceipt,
  parseLabelReceipt,
  parseReviewerReceipt,
} from "./review-workbench-receipts";
import type {
  AppendRecentWrites,
  RunDirectCommand,
} from "./use-review-observation";

export type ReviewMetadataActions = {
  readonly fetchLabels: () => Promise<RepositoryLabelListResponse | undefined>;
  readonly addLabels: (
    labels: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  ) => Promise<void>;
  readonly removeLabels: (
    labels: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  ) => Promise<void>;
  readonly fetchAssignableUsers: (
    query?: string,
  ) => Promise<AssignableUserListResponse | undefined>;
  readonly addAssignees: (
    assignees: ReadonlyArray<{ readonly id: string; readonly login: string }>,
  ) => Promise<void>;
  readonly removeAssignees: (
    assignees: ReadonlyArray<{ readonly id: string; readonly login: string }>,
  ) => Promise<void>;
  readonly assignSelf: () => Promise<ReadonlyArray<string>>;
  readonly fetchReviewers: (
    query?: string,
  ) => Promise<ReviewerListResponse | undefined>;
  readonly requestReviewers: (
    reviewers: ReadonlyArray<{ readonly id: string; readonly login: string }>,
  ) => Promise<void>;
  readonly removeReviewers: (
    reviewers: ReadonlyArray<{ readonly id: string; readonly login: string }>,
  ) => Promise<void>;
  /** `draft: false` publishes a draft for review; `true` takes it back to draft. */
  readonly setDraftState: (draft: boolean) => Promise<void>;
  readonly fetchBaseBranches: (
    query?: string,
  ) => Promise<BaseBranchListResponse | undefined>;
  /** Changes the base branch, then rebuilds the Review against the new base. */
  readonly setBaseBranch: (branch: string) => Promise<BaseBranchChangeOutcome>;
};

/**
 * `RefreshFailed` means GitHub confirmed the base change but the Review still
 * represents the old base; the maintainer refreshes, and the write is never retried.
 */
export type BaseBranchChangeOutcome =
  | { readonly _tag: "Refreshed" }
  | { readonly _tag: "RefreshFailed"; readonly branch: string };

export type ReviewMetadataActionsInput = {
  readonly workbench: WorkbenchResponse;
  readonly runDirectCommand: RunDirectCommand;
  readonly appendRecentWrites: AppendRecentWrites;
  readonly observeConfirmedReviewWrite: (
    recentWrites?: ReadonlyArray<RecentReviewWrite>,
  ) => Promise<void>;
  readonly requireRecovery: (
    operation: RemoteWriteRecovery["operation"],
  ) => void;
  readonly requestRefresh: () => Promise<WorkbenchResponse>;
};

/** Owns pull request metadata reads and strict confirmation handling. */
export function useReviewMetadataActions({
  workbench,
  runDirectCommand,
  appendRecentWrites,
  observeConfirmedReviewWrite,
  requireRecovery,
  requestRefresh,
}: ReviewMetadataActionsInput): ReviewMetadataActions {
  const profileId = workbench.session.key.profileId;
  const reviewId = workbench.review.id;
  const runConfirmed = useCallback(
    async <T>(input: {
      readonly path: string;
      readonly command: object;
      readonly operation: RemoteWriteRecovery["operation"];
      readonly parse: (
        value: Awaited<ReturnType<typeof requestJson>>,
      ) => T | undefined;
      readonly matches: (receipt: T) => boolean;
      readonly recentWrite: (receipt: T) => RecentReviewWrite;
    }): Promise<T> => {
      try {
        const value = await runDirectCommand(() =>
          requestJson(input.path, {
            method: "POST",
            body: { profileId, reviewId, command: input.command },
          }),
        );
        const receipt = input.parse(value);
        // The catch below requires recovery for every unconfirmed write.
        if (receipt === undefined || !input.matches(receipt))
          throw untrustedWriteResponseError(
            "invalid-metadata-confirmation-response",
          );
        const recentWrite = input.recentWrite(receipt);
        appendRecentWrites(recentWrite);
        void observeConfirmedReviewWrite([recentWrite]).catch(() => undefined);
        return receipt;
      } catch (cause: unknown) {
        // `not_found` is named alongside `unavailable` because a metadata write
        // answers 404 for an unreadable record too (`mapMetadataGateFailure`),
        // and splitting the two kinds apart (#122) must not disarm recovery.
        if (
          isOutcomeUnknownRetry(cause) ||
          (cause instanceof PatchdeskApiError &&
            (cause.kind === "unavailable" || cause.kind === "not_found"))
        )
          requireRecovery(input.operation);
        throw cause;
      }
    },
    [
      appendRecentWrites,
      profileId,
      reviewId,
      observeConfirmedReviewWrite,
      requireRecovery,
      runDirectCommand,
    ],
  );

  const fetchLabels = useCallback(
    async () =>
      parseRepositoryLabelListResponse(
        await requestJson(
          `/v1/reviews/labels?profileId=${encodeURIComponent(profileId)}&reviewId=${encodeURIComponent(reviewId)}`,
        ),
      ),
    [profileId, reviewId],
  );
  const fetchAssignableUsers = useCallback(
    async (query?: string) =>
      parseAssignableUserListResponse(
        await requestJson(
          `/v1/reviews/assignees?profileId=${encodeURIComponent(profileId)}&reviewId=${encodeURIComponent(reviewId)}${query === undefined || query === "" ? "" : `&query=${encodeURIComponent(query)}`}`,
        ),
      ),
    [profileId, reviewId],
  );
  const fetchReviewers = useCallback(
    async (query?: string) =>
      parseReviewerListResponse(
        await requestJson(
          `/v1/reviews/reviewers?profileId=${encodeURIComponent(profileId)}&reviewId=${encodeURIComponent(reviewId)}${query === undefined || query === "" ? "" : `&query=${encodeURIComponent(query)}`}`,
        ),
      ),
    [profileId, reviewId],
  );

  const fetchBaseBranches = useCallback(
    async (query?: string) =>
      parseBaseBranchListResponse(
        await requestJson(
          `/v1/reviews/base-branch?profileId=${encodeURIComponent(profileId)}&reviewId=${encodeURIComponent(reviewId)}${query === undefined || query === "" ? "" : `&query=${encodeURIComponent(query)}`}`,
        ),
      ),
    [profileId, reviewId],
  );

  const addLabels = useCallback(
    async (
      labels: ReadonlyArray<{ readonly id: string; readonly name: string }>,
    ) => {
      const names = labels.map((label) => label.name);
      await runConfirmed({
        path: "/v1/reviews/labels/command",
        command: { _tag: "AddLabels", labels },
        operation: "AddLabels",
        parse: parseLabelReceipt,
        matches: (receipt) =>
          receipt._tag === "LabelsAdded" && sameMembers(receipt.added, names),
        recentWrite: () => ({ _tag: "LabelChange", added: names, removed: [] }),
      });
    },
    [runConfirmed],
  );
  const removeLabels = useCallback(
    async (
      labels: ReadonlyArray<{ readonly id: string; readonly name: string }>,
    ) => {
      const names = labels.map((label) => label.name);
      await runConfirmed({
        path: "/v1/reviews/labels/command",
        command: { _tag: "RemoveLabels", labels },
        operation: "RemoveLabels",
        parse: parseLabelReceipt,
        matches: (receipt) =>
          receipt._tag === "LabelsRemoved" &&
          sameMembers(receipt.removed, names),
        recentWrite: () => ({ _tag: "LabelChange", added: [], removed: names }),
      });
    },
    [runConfirmed],
  );
  const addAssignees = useCallback(
    async (
      assignees: ReadonlyArray<{ readonly id: string; readonly login: string }>,
    ) => {
      const logins = assignees.map((assignee) => assignee.login);
      await runConfirmed({
        path: "/v1/reviews/assignees/command",
        command: { _tag: "AddAssignees", assignees },
        operation: "AddAssignees",
        parse: parseAssigneeReceipt,
        matches: (receipt) =>
          receipt._tag === "AssigneesAdded" &&
          sameMembers(receipt.added, logins),
        recentWrite: () => ({
          _tag: "AssigneeChange",
          added: logins,
          removed: [],
        }),
      });
    },
    [runConfirmed],
  );
  const removeAssignees = useCallback(
    async (
      assignees: ReadonlyArray<{ readonly id: string; readonly login: string }>,
    ) => {
      const logins = assignees.map((assignee) => assignee.login);
      await runConfirmed({
        path: "/v1/reviews/assignees/command",
        command: { _tag: "RemoveAssignees", assignees },
        operation: "RemoveAssignees",
        parse: parseAssigneeReceipt,
        matches: (receipt) =>
          receipt._tag === "AssigneesRemoved" &&
          sameMembers(receipt.removed, logins),
        recentWrite: () => ({
          _tag: "AssigneeChange",
          added: [],
          removed: logins,
        }),
      });
    },
    [runConfirmed],
  );
  const assignSelf = useCallback(async () => {
    const receipt = await runConfirmed({
      path: "/v1/reviews/assignees/command",
      command: { _tag: "AssignSelf" },
      operation: "AddAssignees",
      parse: parseAssigneeReceipt,
      matches: (value) =>
        value._tag === "AssigneesAdded" &&
        value.added.length === 1 &&
        value.added[0]?.toLowerCase() === workbench.viewerLogin.toLowerCase(),
      recentWrite: (value) => ({
        _tag: "AssigneeChange",
        added: value._tag === "AssigneesAdded" ? value.added : [],
        removed: [],
      }),
    });
    return receipt._tag === "AssigneesAdded" ? receipt.added : [];
  }, [runConfirmed, workbench.viewerLogin]);
  const requestReviewers = useCallback(
    async (
      reviewers: ReadonlyArray<{ readonly id: string; readonly login: string }>,
    ) => {
      const logins = reviewers.map((reviewer) => reviewer.login);
      await runConfirmed({
        path: "/v1/reviews/reviewers/command",
        command: { _tag: "RequestReviewers", reviewers },
        operation: "RequestReviewers",
        parse: parseReviewerReceipt,
        matches: (receipt) =>
          receipt._tag === "ReviewersRequested" &&
          sameMembers(receipt.requested, logins),
        recentWrite: () => ({
          _tag: "ReviewerChange",
          requested: logins,
          removed: [],
        }),
      });
    },
    [runConfirmed],
  );
  const removeReviewers = useCallback(
    async (
      reviewers: ReadonlyArray<{ readonly id: string; readonly login: string }>,
    ) => {
      const logins = reviewers.map((reviewer) => reviewer.login);
      await runConfirmed({
        path: "/v1/reviews/reviewers/command",
        command: { _tag: "RemoveReviewers", reviewers },
        operation: "RemoveReviewers",
        parse: parseReviewerReceipt,
        matches: (receipt) =>
          receipt._tag === "ReviewersRemoved" &&
          sameMembers(receipt.removed, logins),
        recentWrite: () => ({
          _tag: "ReviewerChange",
          requested: [],
          removed: logins,
        }),
      });
    },
    [runConfirmed],
  );
  const setDraftState = useCallback(
    async (draft: boolean) => {
      await runConfirmed({
        path: "/v1/reviews/draft-state/command",
        command: { _tag: "SetDraftState", draft },
        operation: "SetDraftState",
        parse: parseDraftStateReceipt,
        matches: (receipt) => receipt.draft === draft,
        recentWrite: () => ({ _tag: "DraftStateChange", draft }),
      });
    },
    [runConfirmed],
  );
  const setBaseBranch = useCallback(
    async (branch: string): Promise<BaseBranchChangeOutcome> => {
      await runConfirmed({
        path: "/v1/reviews/base-branch/command",
        command: { _tag: "SetBaseBranch", branch },
        operation: "SetBaseBranch",
        parse: parseBaseBranchReceipt,
        matches: (receipt) => receipt.branch === branch,
        recentWrite: () => ({ _tag: "BaseBranchChange", branch }),
      });
      // A new base moves the revision identity, so only Refresh can adopt it (ADR 0017).
      try {
        await requestRefresh();
        return { _tag: "Refreshed" };
      } catch {
        return { _tag: "RefreshFailed", branch };
      }
    },
    [requestRefresh, runConfirmed],
  );

  return {
    fetchLabels,
    addLabels,
    removeLabels,
    fetchAssignableUsers,
    addAssignees,
    removeAssignees,
    assignSelf,
    fetchReviewers,
    requestReviewers,
    removeReviewers,
    setDraftState,
    fetchBaseBranches,
    setBaseBranch,
  };
}

function sameMembers(
  actual: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}
