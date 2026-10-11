import * as v from "valibot";
import {
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { GuideReadingSaveQueue } from "#src/renderer/src/hooks/guide-reading-save-queue";
import { GuideReadingFlushContext } from "#src/renderer/src/hooks/use-guide-reading-flush";
import type { GuideReadingControls } from "#src/renderer/src/hooks/use-guide-reading-state";
import {
  guideReadingStateSchema,
  type GuideReadingState,
} from "#src/domain/guide-reading-state";
import type { RetainedGuide } from "#src/domain/guide";
import { definedProps } from "#src/domain/defined-props";
import type { WorkbenchResponse } from "#src/renderer/src/renderer-contracts";
import {
  canonicalWorkbenchModel,
  workbenchFixtureData,
} from "#src/renderer/src/flows/fixtures/workbench-fixture-data";
import { GuideReader, GuideReadingSaveError } from "./guide-reader";
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
  reading,
}: {
  readonly reading: GuideReadingControls;
  readonly model: WorkbenchResponse;
  readonly guide: RetainedGuide;
}): React.JSX.Element {
  const diffAuthoring = useContext(WalkthroughDiffAuthoringContext);
  const disabledReason = guideReviewDisabledReason(model);
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <GuideReadingSaveError reading={reading} />
      <GuideReader
        guide={guide}
        reading={reading}
        viewedPaths={new Set(model.viewedPaths)}
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
  const canonicalWorkbench = canonicalWorkbenchModel({
    ...workbenchFixtureData,
    fullPatch: guide.patchText,
    conversationThreads:
      conversationThreads ?? workbenchFixtureData.conversationThreads,
  });
  const base = {
    ...canonicalWorkbench,
    session: {
      ...canonicalWorkbench.session,
      id: "github.com__octo-org__patchdesk__pr-42__sha-aaaaaaaa__base-00000000__b48f8e2e76ca",
    },
  };
  const [selectedView, setSelectedView] = useState<
    "combined" | "committed" | "uncommitted"
  >("combined");
  const failSave = useRef(false);
  const [failing, setFailing] = useState(false);
  const [queue] = useState(() => {
    let canonical: GuideReadingState = v.parse(guideReadingStateSchema, {
      runId:
        "insight-guide-1-aaaaaaaaaaaa-github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
      sessionId: base.session.id,
      version: 0,
      reviewedGroupIds: [],
      expandedAppearances: [],
      anchor: { kind: "top" },
    });
    return new GuideReadingSaveQueue(
      canonical,
      async (content, expectedVersion) => {
        if (failSave.current) throw new Error("Fixture reading save refused");
        canonical = { ...canonical, ...content, version: expectedVersion + 1 };
        return canonical;
      },
      async () => canonical,
      () => undefined,
    );
  });
  const readingOwner = useContext(GuideReadingFlushContext);
  useLayoutEffect(
    () =>
      readingOwner?.register((retry) =>
        retry ? queue.retry() : queue.flush(),
      ),
    [queue, readingOwner],
  );
  const readingSnapshot = useSyncExternalStore(queue.subscribe, queue.read);
  const reading: GuideReadingControls = {
    ...readingSnapshot,
    edit: (content) => queue.edit(content),
    retry: queue.retry,
  };
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
    viewedPaths: [...paths],
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
          aria-pressed={failing}
          onClick={() => {
            failSave.current = !failing;
            setFailing(!failing);
          }}
        >
          Fail Guide reading saves
        </Button>
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
        {...(comments
          ? {}
          : {
              localPatchView: {
                selected: selectedView,
                shown: {
                  sessionId: base.session.id,
                  view: selectedView,
                  patch: guide.patchText,
                  viewedPaths: selectedView === "combined" ? [...paths] : [],
                },
                status: "ready" as const,
                select: setSelectedView,
              },
            })}
        initialState={{
          activeTab: "insights",
          selectedPath: "src/recovery.ts",
        }}
        slots={{
          insights: (
            <FixtureReader model={model} guide={guide} reading={reading} />
          ),
          conversation: null,
          mergeAction: null,
        }}
      />
    </div>
  );
}
