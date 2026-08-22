import { useCallback } from "react";

import type { RecentReviewWrite } from "../../../domain/recent-review-write";
import { requestJson } from "../api-client";
import {
  parseAssignableUserListResponse,
  parseRepositoryLabelListResponse,
  parseReviewerListResponse,
  type AssignableUserListResponse,
  type RepositoryLabelListResponse,
  type ReviewerListResponse,
  type WorkbenchResponse,
} from "../renderer-contracts";
import {
  parseAssigneeReceipt,
  parseLabelReceipt,
  parseReviewerReceipt,
} from "./review-workbench-receipts";

type RunDirectCommand = <T>(operation: () => Promise<T>) => Promise<T>;
type AppendRecentWrites = (
  entries: RecentReviewWrite | ReadonlyArray<RecentReviewWrite>,
) => void;

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
};

export type ReviewMetadataActionsInput = {
  readonly workbench: WorkbenchResponse;
  readonly runDirectCommand: RunDirectCommand;
  readonly appendRecentWrites: AppendRecentWrites;
};

/** Owns pull-request metadata reads, writes, and their local write receipts. */
export function useReviewMetadataActions({
  workbench,
  runDirectCommand,
  appendRecentWrites,
}: ReviewMetadataActionsInput): ReviewMetadataActions {
  const fetchLabels = useCallback(async (): Promise<
    RepositoryLabelListResponse | undefined
  > => {
    const value = await requestJson(
      `/v1/reviews/labels?profileId=${encodeURIComponent(workbench.session.key.profileId)}&reviewId=${encodeURIComponent(workbench.review.id)}`,
    );
    return parseRepositoryLabelListResponse(value);
  }, [workbench]);

  const addLabels = useCallback(
    async (
      labels: ReadonlyArray<{ readonly id: string; readonly name: string }>,
    ): Promise<void> => {
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/labels/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: { _tag: "AddLabels", labels },
          },
        }),
      );
      const receipt = parseLabelReceipt(value);
      if (receipt?._tag === "LabelsAdded") {
        appendRecentWrites({
          _tag: "LabelChange",
          added: receipt.added,
          removed: [],
        });
      }
    },
    [appendRecentWrites, runDirectCommand, workbench],
  );

  const removeLabels = useCallback(
    async (
      labels: ReadonlyArray<{ readonly id: string; readonly name: string }>,
    ): Promise<void> => {
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/labels/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: { _tag: "RemoveLabels", labels },
          },
        }),
      );
      const receipt = parseLabelReceipt(value);
      if (receipt?._tag === "LabelsRemoved") {
        appendRecentWrites({
          _tag: "LabelChange",
          added: [],
          removed: receipt.removed,
        });
      }
    },
    [appendRecentWrites, runDirectCommand, workbench],
  );

  const fetchAssignableUsers = useCallback(
    async (query?: string): Promise<AssignableUserListResponse | undefined> => {
      const queryField =
        query === undefined || query === ""
          ? ""
          : `&query=${encodeURIComponent(query)}`;
      const value = await requestJson(
        `/v1/reviews/assignees?profileId=${encodeURIComponent(workbench.session.key.profileId)}&reviewId=${encodeURIComponent(workbench.review.id)}${queryField}`,
      );
      return parseAssignableUserListResponse(value);
    },
    [workbench],
  );

  const addAssignees = useCallback(
    async (
      assignees: ReadonlyArray<{ readonly id: string; readonly login: string }>,
    ): Promise<void> => {
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/assignees/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: { _tag: "AddAssignees", assignees },
          },
        }),
      );
      const receipt = parseAssigneeReceipt(value);
      if (receipt?._tag === "AssigneesAdded") {
        appendRecentWrites({
          _tag: "AssigneeChange",
          added: receipt.added,
          removed: [],
        });
      }
    },
    [appendRecentWrites, runDirectCommand, workbench],
  );

  const removeAssignees = useCallback(
    async (
      assignees: ReadonlyArray<{ readonly id: string; readonly login: string }>,
    ): Promise<void> => {
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/assignees/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: { _tag: "RemoveAssignees", assignees },
          },
        }),
      );
      const receipt = parseAssigneeReceipt(value);
      if (receipt?._tag === "AssigneesRemoved") {
        appendRecentWrites({
          _tag: "AssigneeChange",
          added: [],
          removed: receipt.removed,
        });
      }
    },
    [appendRecentWrites, runDirectCommand, workbench],
  );

  const assignSelf = useCallback(async (): Promise<ReadonlyArray<string>> => {
    const value = await runDirectCommand(() =>
      requestJson("/v1/reviews/assignees/command", {
        method: "POST",
        body: {
          profileId: workbench.session.key.profileId,
          reviewId: workbench.review.id,
          command: { _tag: "AssignSelf" },
        },
      }),
    );
    const receipt = parseAssigneeReceipt(value);
    if (receipt?._tag === "AssigneesAdded") {
      appendRecentWrites({
        _tag: "AssigneeChange",
        added: receipt.added,
        removed: [],
      });
      return receipt.added;
    }
    return [];
  }, [appendRecentWrites, runDirectCommand, workbench]);

  const fetchReviewers = useCallback(
    async (query?: string): Promise<ReviewerListResponse | undefined> => {
      const queryField =
        query === undefined || query === ""
          ? ""
          : `&query=${encodeURIComponent(query)}`;
      const value = await requestJson(
        `/v1/reviews/reviewers?profileId=${encodeURIComponent(workbench.session.key.profileId)}&reviewId=${encodeURIComponent(workbench.review.id)}${queryField}`,
      );
      return parseReviewerListResponse(value);
    },
    [workbench],
  );

  const requestReviewers = useCallback(
    async (
      reviewers: ReadonlyArray<{ readonly id: string; readonly login: string }>,
    ): Promise<void> => {
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/reviewers/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: { _tag: "RequestReviewers", reviewers },
          },
        }),
      );
      const receipt = parseReviewerReceipt(value);
      if (receipt?._tag === "ReviewersRequested") {
        appendRecentWrites({
          _tag: "ReviewerChange",
          requested: receipt.requested,
          removed: [],
        });
      }
    },
    [appendRecentWrites, runDirectCommand, workbench],
  );

  const removeReviewers = useCallback(
    async (
      reviewers: ReadonlyArray<{ readonly id: string; readonly login: string }>,
    ): Promise<void> => {
      const value = await runDirectCommand(() =>
        requestJson("/v1/reviews/reviewers/command", {
          method: "POST",
          body: {
            profileId: workbench.session.key.profileId,
            reviewId: workbench.review.id,
            command: { _tag: "RemoveReviewers", reviewers },
          },
        }),
      );
      const receipt = parseReviewerReceipt(value);
      if (receipt?._tag === "ReviewersRemoved") {
        appendRecentWrites({
          _tag: "ReviewerChange",
          requested: [],
          removed: receipt.removed,
        });
      }
    },
    [appendRecentWrites, runDirectCommand, workbench],
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
  };
}
