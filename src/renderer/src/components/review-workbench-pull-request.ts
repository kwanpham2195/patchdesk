import { definedProps } from "../../../domain/defined-props";
import { fingerprintPatchAnchor } from "../../../domain/diff-anchor";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parsePullRequestNumber,
  parseRepoRelativePath,
} from "../../../domain/ids";
import { mapFindingLocation, parseUnifiedPatch } from "../../../domain/patch";
import type { PullRequestRef } from "../../../domain/pull-request";
import type { WorkbenchResponse } from "../renderer-contracts";
import { workbenchPullRequestNumber } from "../review-source";
import type { ReviewConversationActions } from "./conversation-thread-card";
import type {
  LocalCommentAuthoring,
  LocalCommentLocation,
} from "./review-diff-view";
import type { ReviewWorkbenchActions } from "./review-workbench-contracts";

/** The subset of `Conversation`'s props built conditionally, so the
 * `conversationActions` prop is only added (never spread from a conditional
 * empty object) when at least one direct-conversation action is wired. */
type ConversationTabProps = {
  readonly conversationActions?: ReviewConversationActions;
};

/** Direct conversation actions for both `<Conversation>` (the Conversation
 * tab) and the diff view, derived from the same underlying `actions` so
 * Reply/Resolve/Edit/Delete wiring never drifts between the two surfaces;
 * Dismiss is consumed only by the Conversation tab's review summaries.
 * The diff view additionally only wires them when `selectedCommitSha` is
 * unset (viewing the full Review diff, not one commit's slice); the
 * Conversation tab is independent of that selection. */
type DirectConversationActionProps = {
  readonly conversationTabProps: ConversationTabProps;
  readonly diffConversationActions: ReviewConversationActions | undefined;
};
export function directConversationActionProps(
  actions: Pick<
    ReviewWorkbenchActions,
    | "setThreadState"
    | "replyToThread"
    | "editComment"
    | "deleteComment"
    | "dismissReview"
  >,
  selectedCommitSha: string | undefined,
): DirectConversationActionProps {
  const hasAnyAction =
    actions.setThreadState !== undefined ||
    actions.replyToThread !== undefined ||
    actions.editComment !== undefined ||
    actions.deleteComment !== undefined ||
    actions.dismissReview !== undefined;
  const wired: ReviewConversationActions = definedProps({
    setThreadState: actions.setThreadState,
    replyToThread: actions.replyToThread,
    editComment: actions.editComment,
    deleteComment: actions.deleteComment,
    dismissReview: actions.dismissReview,
  });
  return {
    // `exactOptionalPropertyTypes` treats `conversationActions={undefined}` as
    // distinct from omitting the prop, so the prop itself is only added here
    // (never spread from a conditional empty-object).
    conversationTabProps: definedProps({
      conversationActions: hasAnyAction ? wired : undefined,
    }),
    diffConversationActions:
      selectedCommitSha === undefined && hasAnyAction ? wired : undefined,
  };
}

export function pullRequestExternalRef(
  model: WorkbenchResponse,
): PullRequestRef | undefined {
  const prNumber = workbenchPullRequestNumber(model.session.key.source);
  if (prNumber === undefined) return undefined;
  const source = model.pullRequest?.ref ?? {
    host: model.session.key.host,
    owner: model.session.key.owner,
    repo: model.session.key.repo,
    number: prNumber,
  };
  const host = parseGitHubHost(source.host);
  const owner = parseGitHubOwner(source.owner);
  const repo = parseGitHubRepoName(source.repo);
  const number = parsePullRequestNumber(source.number);
  if (
    host._tag === "err" ||
    owner._tag === "err" ||
    repo._tag === "err" ||
    number._tag === "err"
  )
    return undefined;
  return {
    host: host.value,
    owner: owner.value,
    repo: repo.value,
    number: number.value,
  };
}

export function createHeadSideCommentAuthoring(
  base: LocalCommentAuthoring | undefined,
  fullPatch: string,
): LocalCommentAuthoring | undefined {
  if (base?.enabled !== true) return undefined;
  const files = parseUnifiedPatch(fullPatch);
  // This diff's new side is the pull request head, so a new-side line the full patch shows is the same GitHub coordinate; its old side is not the base.
  const fullPatchAnchor = (location: LocalCommentLocation) => {
    const path = parseRepoRelativePath(location.path);
    if (location.side !== "new" || path._tag === "err") return undefined;
    const mapped = mapFindingLocation(files, {
      file: location.path,
      lineStart: location.startLine,
      lineEnd: location.line,
      diffSide: "new",
    });
    if (mapped.mappingStatus !== "mapped" || mapped.path !== location.path)
      return undefined;
    const anchor = {
      path: path.value,
      startLine: location.startLine,
      line: location.line,
      side: location.side,
    };
    // GitHub refuses a range that leaves one hunk of the pull request diff, even when the commit's own hunk holds it.
    return anchor.startLine === anchor.line ||
      fingerprintPatchAnchor(fullPatch, anchor) !== undefined
      ? anchor
      : undefined;
  };
  return {
    enabled: true,
    ...definedProps({ kind: base.kind }),
    canAuthor: (location) => fullPatchAnchor(location) !== undefined,
    onSelectionChange: (location) => {
      if (fullPatchAnchor(location) !== undefined)
        base.onSelectionChange?.(location);
    },
    onSave: async (input) => {
      const anchor = fullPatchAnchor(input);
      if (anchor === undefined) return;
      return base.onSave({
        ...input,
        ...definedProps({
          fingerprint: fingerprintPatchAnchor(fullPatch, anchor),
        }),
      });
    },
  };
}

/**
 * The Finish review handler while the header shows an enabled Finish review
 * button, the same conditions `ReviewWorkbenchHeader` and
 * `PendingReviewHeaderAction` render it under; ⌘K lists the command only then.
 */
export function visibleFinishReview(
  model: WorkbenchResponse,
  actions: ReviewWorkbenchActions,
  terminal: boolean,
): (() => void) | undefined {
  const pendingReview = actions.pendingReview;
  if (
    pendingReview === undefined ||
    terminal ||
    workbenchPullRequestNumber(model.session.key.source) === undefined ||
    pendingReview.projection?.state !== "pending" ||
    pendingReview.busy
  )
    return undefined;
  return pendingReview.onOpenFinishDialog;
}
