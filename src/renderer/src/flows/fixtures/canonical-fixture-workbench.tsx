import {
  ReviewWorkbench,
  type ReviewWorkbenchActions,
} from "../../components/review-workbench";
import type { PullRequestOverviewMerge } from "../../components/pr-overview-sheet";
import type { AssigneesSectionActions } from "../../components/assignee-picker";
import type { ReviewerPickerActions } from "../../components/reviewer-picker";
import type { WorkbenchResponse } from "../../renderer-contracts";
import type { NavigationState } from "./navigation-state";
import {
  fixtureAssigneeActions,
  fixtureLabelCatalog,
  fixtureReviewerActions,
} from "./rail-fixture-actions";
import {
  canonicalWorkbenchModel,
  type workbenchFixtureData,
} from "./workbench-fixture-data";

/** Mutable form of `ReviewWorkbenchActions`, so a fixture can assign its
 * optional `merge` field only when present instead of using a conditional
 * empty-object spread. */
type MutableReviewWorkbenchActions = {
  -readonly [K in keyof ReviewWorkbenchActions]: ReviewWorkbenchActions[K];
};

export function CanonicalFixtureWorkbench({
  data,
  onNavigationStateChange,
  modelOverrides,
  mergeAction,
  assigneeActions,
  reviewerActions,
}: {
  readonly data: typeof workbenchFixtureData;
  readonly onNavigationStateChange: (state: NavigationState) => void;
  readonly modelOverrides?: Partial<
    Pick<
      WorkbenchResponse,
      | "mergeReadiness"
      | "mergeReasons"
      | "conversation"
      | "review"
      | "pendingReview"
    >
  >;
  readonly mergeAction?: PullRequestOverviewMerge;
  readonly assigneeActions?: AssigneesSectionActions;
  readonly reviewerActions?: ReviewerPickerActions;
}): React.JSX.Element {
  const model = canonicalWorkbenchModel(data);
  const merged =
    modelOverrides === undefined ? model : { ...model, ...modelOverrides };
  // Built as a mutable local (assignable to the readonly-field
  // `ReviewWorkbenchActions` structurally) and given `merge` only when
  // present, rather than a conditional empty-object spread: under this
  // project's `exactOptionalPropertyTypes`, an optional field must be
  // absent, not merely set to `undefined`.
  const actions: MutableReviewWorkbenchActions = {
    detectUpdates: async () => undefined,
    refresh: async () => undefined,
    loadCommitDiff: async () => {
      throw new Error("No commit fixture is configured");
    },
    localCommentAuthoring: { enabled: true, onSave: async () => undefined },
    reportNavigationState: onNavigationStateChange,
    labels: {
      fetchLabels: async () => fixtureLabelCatalog,
      addLabels: async () => undefined,
      removeLabels: async () => undefined,
    },
    assignees: assigneeActions ?? fixtureAssigneeActions,
    reviewers: reviewerActions ?? fixtureReviewerActions,
  };
  if (mergeAction !== undefined) actions.merge = mergeAction;
  return (
    <ReviewWorkbench
      model={merged}
      actions={actions}
      slots={{
        insights: (
          <section aria-label="Review insights" className="p-6">
            <h2 className="text-lg font-semibold">Insights</h2>
            <p className="text-sm text-muted-foreground">
              Insight fixture content.
            </p>
          </section>
        ),
        conversation: null,
        mergeAction: null,
      }}
    />
  );
}
