import { definedProps } from "#src/domain/defined-props";
import type { WalkthroughSummaryState } from "#src/renderer/src/hooks/use-walkthrough-summary";
import { walkthroughRevisionMatches } from "#src/renderer/src/hooks/use-walkthrough-summary";
import { usePagedWalkthrough } from "#src/renderer/src/hooks/use-paged-walkthrough";
import { useWalkthroughProgress } from "#src/renderer/src/hooks/use-walkthrough-progress";
import type { WalkthroughSummary } from "#src/domain/walkthrough-progress";
import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
import type { WalkthroughDiffAuthoring } from "./walkthrough-diff-authoring";
import type { ReadOnlyConversationAnnotation } from "#src/renderer/src/inline-conversation-mapping";
import { WalkthroughProgressReader } from "./walkthrough-progress-reader";
import { PagedWalkthroughCitations } from "./paged-walkthrough-citations";
import { InlineError } from "./ui/inline-error";
import { Button } from "./ui/button";

type ReaderProps = {
  readonly workbench: WorkbenchResponse;
  readonly focused: boolean;
  readonly onFocusedChange: (focused: boolean) => void;
  readonly refresh: () => void;
  readonly onOpenDiff?: () => void;
  readonly annotations?: ReadonlyArray<ReadOnlyConversationAnnotation>;
  readonly diffAuthoring?: WalkthroughDiffAuthoring;
  readonly empty?: React.ReactNode;
  readonly onRegenerate?: () => void;
  readonly regenerateDisabled?: boolean;
};

function ReadyWalkthroughReader({
  summary,
  ...props
}: ReaderProps & {
  readonly summary: Extract<WalkthroughSummary, { _tag: "ready" }>;
}): React.JSX.Element {
  const workbench = props.workbench;
  const source = {
    profileId: workbench.session.key.profileId,
    reviewId: workbench.review.id,
    digest: summary.digest,
  };
  const { reader, snapshot } = usePagedWalkthrough(
    source,
    summary.currentSectionId,
  );
  const navigation = snapshot.navigation ?? {
    kind: "navigation" as const,
    items: [],
    next: null,
    previous: null,
  };
  const sections =
    snapshot.section === null ||
    navigation.items.some(
      (item) => item.sectionId === snapshot.section?.sectionId,
    )
      ? navigation.items
      : [...navigation.items, snapshot.section];
  const progress = useWalkthroughProgress({
    ...source,
    reviewOpen: workbench.review.status === "open",
    summary,
    sections,
    onSelectSection: reader.selectSection,
    onSaved: (mutation) => {
      if (mutation.action === "set_reviewed")
        reader.setReviewed(mutation.sectionId, mutation.value);
      props.refresh();
    },
  });
  const current = walkthroughRevisionMatches(workbench, summary);
  const discussion = !current
    ? "stale"
    : workbench.revision.freshness !== "fresh" ||
        workbench.fullPatch === undefined ||
        workbench.conversation.inline?.complete !== true
      ? "loading"
      : undefined;
  const pullRequest = workbench.session.key.source.kind === "pull_request";
  const authoring =
    current &&
    workbench.review.status === "open" &&
    (!pullRequest || workbench.revision.freshness === "fresh") &&
    workbench.fullPatch !== undefined
      ? props.diffAuthoring
      : undefined;
  return (
    <>
      {snapshot.failed ? (
        <InlineError>
          The Walkthrough could not be read. Its stored result is unchanged;
          reopen the Review to retry.
        </InlineError>
      ) : null}
      <WalkthroughProgressReader
        counts={{
          sections: summary.sections,
          reviewed: summary.reviewedCount,
          citedHunks: summary.citedHunks,
          hunks: summary.hunks,
          uncited: summary.uncited,
        }}
        navigation={navigation}
        activeSection={snapshot.section}
        onNavigationPage={reader.loadNavigation}
        controls={progress}
        focused={props.focused}
        onFocusedChange={props.onFocusedChange}
        {...definedProps({
          onOpenDiff: props.onOpenDiff,
          discussionUnavailable: pullRequest ? discussion : undefined,
        })}
        evidence={
          snapshot.section === null ? null : (
            <PagedWalkthroughCitations
              source={source}
              sectionId={snapshot.section.sectionId}
              page={snapshot.citations}
              onPage={reader.loadCitations}
              {...definedProps({
                annotations:
                  discussion === undefined ? props.annotations : undefined,
                diffAuthoring: authoring,
              })}
            />
          )
        }
      />
    </>
  );
}

/** No whole-result or legacy prose fallback is reachable from this reader. */
export function PagedWalkthroughReader({
  state,
  ...props
}: ReaderProps & {
  readonly state: WalkthroughSummaryState;
}): React.JSX.Element {
  if (state.status === "loading")
    return <p role="status">Loading Walkthrough…</p>;
  if (state.status === "failed")
    return (
      <InlineError>
        The Walkthrough could not be read. Its stored result is unchanged;
        reopen the Review to retry.
      </InlineError>
    );
  if (state.status === "unavailable")
    return (
      <>
        <p role="status">
          Walkthrough unavailable. Regenerate to create a readable Walkthrough.
        </p>
        {props.onRegenerate === undefined ? null : (
          <Button
            size="sm"
            onClick={props.onRegenerate}
            disabled={props.regenerateDisabled}
          >
            Regenerate
          </Button>
        )}
      </>
    );
  if (state.summary._tag === "none")
    return <>{state.summary.run === null ? props.empty : null}</>;
  return (
    <ReadyWalkthroughReader
      key={state.summary.digest}
      summary={state.summary}
      {...props}
    />
  );
}
