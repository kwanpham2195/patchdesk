import { useContext, useState } from "react";
import type { RetainedGuide } from "#src/domain/guide";
import { definedProps } from "#src/domain/defined-props";
import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
import {
  canonicalWorkbenchModel,
  workbenchFixtureData,
} from "#src/renderer/src/flows/fixtures/workbench-fixture-data";
import { GuideReader } from "./guide-reader";
import { guideReviewDisabledReason } from "./guide-review-controls";
import { ReviewWorkbench } from "./review-workbench";
import type {
  LocalCommentAuthoring,
  ReviewConversationActions,
} from "./review-diff-view";
import type { ReviewWorkbenchActions } from "./review-workbench-contracts";
import { WalkthroughDiffAuthoringContext } from "./walkthrough-diff-authoring";
import { Button } from "./ui/button";

function FixtureReader({
  model,
  guide,
}: {
  readonly model: WorkbenchResponse;
  readonly guide: RetainedGuide;
}): React.JSX.Element {
  const diffAuthoring = useContext(WalkthroughDiffAuthoringContext);
  const disabledReason = guideReviewDisabledReason(model);
  return (
    <div className="h-full overflow-auto">
      <GuideReader
        guide={guide}
        {...definedProps({ disabledReason })}
        {...(disabledReason === undefined
          ? definedProps({ diffAuthoring })
          : {})}
      />
    </div>
  );
}

/** In-memory actions exercise the production workbench without provider or GitHub calls. */
export function GuideFixtureWorkbench({
  guide,
  outdated,
  localCommentAuthoring,
  conversationActions,
  conversationThreads,
}: {
  readonly guide: RetainedGuide;
  readonly outdated: boolean;
  readonly localCommentAuthoring?: LocalCommentAuthoring;
  readonly conversationActions?: ReviewConversationActions;
  readonly conversationThreads?: NonNullable<
    WorkbenchResponse["conversation"]["inline"]
  >["threads"];
}): React.JSX.Element {
  const [paths, setPaths] = useState<ReadonlySet<string>>(new Set());
  const [notes, setNotes] = useState<
    NonNullable<WorkbenchResponse["localDrafts"]>
  >([]);
  const [comments, setComments] = useState(localCommentAuthoring !== undefined);
  const base = canonicalWorkbenchModel({
    ...workbenchFixtureData,
    fullPatch: guide.patchText,
    conversationThreads:
      conversationThreads ?? workbenchFixtureData.conversationThreads,
  });
  const model: WorkbenchResponse = {
    ...base,
    session: {
      ...base.session,
      key: {
        ...base.session.key,
        source: comments
          ? base.session.key.source
          : { kind: "local_branch", branch: "fixture", baseRef: "main" },
      },
    },
    localDrafts: notes,
    insights: {
      ...base.insights,
      analysis: { status: "not_generated" },
      guide: {
        status: outdated ? "outdated" : "current",
        artifactStatus: "verified",
        retained: {
          runId: "guide-fixture",
          sessionId: outdated ? "older-session" : base.session.id,
          headSha: base.revision.reviewedHeadSha,
          generatedAt: "2026-10-08T00:00:00.000Z",
          freshness: outdated ? "outdated" : "current",
          value: guide,
        },
      },
    },
  };
  const actions: ReviewWorkbenchActions = {
    detectUpdates: async () => undefined,
    refresh: async () => undefined,
    loadCommitDiff: async () => {
      throw new Error("No fixture commit diff");
    },
    loadSinceReviewDiff: async () => {
      throw new Error("No fixture since-review diff");
    },
    loadSinceLastRefreshDiff: async () => {
      throw new Error("No fixture since-refresh diff");
    },
    reportNavigationState: () => undefined,
    ...conversationActions,
    localCommentAuthoring: localCommentAuthoring ?? {
      enabled: true,
      ...definedProps({ kind: comments ? undefined : ("note" as const) }),
      onSave: async () => {
        throw new Error("Fixture comment refused; draft retained");
      },
    },
    ...(!comments
      ? {
          localNotes: {
            add: async (location, text) => {
              setNotes((current) => [
                ...current,
                {
                  kind: "note",
                  noteId: `fixture-note-${current.length + 1}`,
                  sessionId: base.session.id,
                  view: "combined",
                  ...location,
                  text,
                },
              ]);
            },
            edit: async (noteId, text) => {
              setNotes((current) =>
                current.map((entry) =>
                  entry.kind === "note" && entry.noteId === noteId
                    ? { ...entry, text }
                    : entry,
                ),
              );
            },
            remove: async (noteId) => {
              setNotes((current) =>
                current.filter(
                  (entry) => entry.kind !== "note" || entry.noteId !== noteId,
                ),
              );
            },
          },
        }
      : {
          pendingReviewComposer: {
            state: { state: "none" as const },
            busy: false,
            onStartReview: async () => {
              throw new Error("Fixture review refused; draft retained");
            },
            onAddReviewComment: async () => {
              throw new Error("Fixture review refused; draft retained");
            },
          },
        }),
  };
  return (
    <div className="flex h-[48rem] flex-col border">
      <div className="flex shrink-0 gap-2 p-2">
        <Button
          variant="outline"
          onClick={() => setComments((value) => !value)}
        >
          {comments ? "Use local notes fixture" : "Use pending review fixture"}
        </Button>
      </div>
      <ReviewWorkbench
        model={model}
        actions={actions}
        viewedFiles={{ paths, setPaths, saveFailed: false }}
        initialState={{
          activeTab: "insights",
          selectedPath: "src/recovery.ts",
        }}
        slots={{
          insights: <FixtureReader model={model} guide={guide} />,
          conversation: null,
          mergeAction: null,
        }}
      />
    </div>
  );
}
