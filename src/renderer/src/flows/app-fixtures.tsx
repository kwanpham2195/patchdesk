import { useMemo, useRef, useState } from "react";
import {
  ReviewWorkbench,
  type ReviewWorkbenchActions,
  type ReviewWorkbenchInitialState,
} from "../components/review-workbench";
import { NarrativeWalkthrough } from "../components/narrative-walkthrough";
import { DiffWorkbench } from "../components/diff-workbench";
import { CompactMergeCommand } from "../components/compact-merge-command";
import type { PullRequestOverviewMerge } from "../components/pr-overview-sheet";
import { PullRequestDescription } from "../components/pull-request-description";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { ModelCombobox } from "../components/model-combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import type { MergeReadiness } from "../../../domain/merge-readiness";
import { parsePullRequestInput } from "../../../domain/pull-request";
import type { WorkbenchResponse } from "../renderer-contracts";

type NavigationState = "clear" | "dirty_draft" | "write_pending";

/** A `conversation.inline.threads` entry, as the Threads navigator section
 * consumes it -- seeded per fixture so the browser suite can exercise the
 * Threads section against real thread data without inventing a new model
 * shape. */
type FixtureConversationThread = NonNullable<
  WorkbenchResponse["conversation"]["inline"]
>["threads"][number];
const noConversationThreads: ReadonlyArray<FixtureConversationThread> = [];

/** Mutable form of `ReviewWorkbenchActions`, so a fixture can assign its
 * optional `merge` field only when present instead of using a conditional
 * empty-object spread. */
type MutableReviewWorkbenchActions = {
  -readonly [K in keyof ReviewWorkbenchActions]: ReviewWorkbenchActions[K];
};

export function AppFixtureContent({
  hash,
  onNavigationStateChange,
}: {
  readonly hash: string;
  readonly onNavigationStateChange: (state: NavigationState) => void;
}): React.ReactNode {
  if (hash === "#mermaid-fixture") {
    const parsedPullRequest = parsePullRequestInput(
      "https://github.com/centraldigital/patchdesk/pull/42",
    );
    if (parsedPullRequest._tag === "err")
      throw new Error("Fixture pull request is invalid");
    return (
      <div className="mx-auto max-w-3xl p-6">
        <PullRequestDescription
          markdown={"```mermaid\ngraph TD\n  A[Open] --> B[Review]\n```"}
          pullRequest={parsedPullRequest.value}
        />
      </div>
    );
  }
  if (hash === "#diff-fixture")
    return (
      <DiffWorkbench
        patch={fixturePatch}
        finding={{ file: "src/b.ts", lineStart: 1, diffSide: "new" }}
      />
    );
  if (hash === "#walkthrough-fixture")
    return (
      <WalkthroughFixture onNavigationStateChange={onNavigationStateChange} />
    );
  if (
    hash === "#workbench-fixture" ||
    hash === "#long-workbench-fixture" ||
    hash === "#active-follow-fixture"
  ) {
    const fixture =
      hash === "#long-workbench-fixture"
        ? longWorkbenchFixtureData
        : hash === "#active-follow-fixture"
          ? activeFollowFixtureData
          : workbenchFixtureData;
    return (
      <CanonicalFixtureWorkbench
        data={fixture}
        onNavigationStateChange={onNavigationStateChange}
      />
    );
  }
  if (
    hash === "#blocked-merge-fixture" ||
    hash === "#acknowledgement-merge-fixture" ||
    hash === "#overview-detail-fixture"
  ) {
    const blocked = hash === "#blocked-merge-fixture";
    const detail = hash === "#overview-detail-fixture";
    const readiness: MergeReadiness = blocked
      ? { _tag: "Blocked", blockers: [], warnings: [] }
      : {
          _tag: "NeedsAcknowledgement",
          blockers: [],
          warnings: ["request_changes", "analysis_finding"],
        };
    // SAFETY: `readiness` is a MergeReadiness domain value built two lines
    // above; its `blockers`/`warnings` are readonly arrays of a narrower
    // literal-union blocker/warning code, which the renderer-contract type
    // widens to plain `string[]`. Every element is already a valid member of
    // that wider type, so the cast only relaxes readonly-ness and literal
    // narrowing, not the runtime shape.
    const mergeReadiness = readiness as WorkbenchResponse["mergeReadiness"];
    const mergeReasons = blocked
      ? [
          {
            code: "checks" as const,
            message: "Required checks have not passed.",
            source: "checks" as const,
            availability: "available" as const,
            openOnGitHub: true,
          },
        ]
      : [];
    const parsedPullRequest = parsePullRequestInput(
      "https://github.com/centraldigital/patchdesk/pull/42",
    );
    if (parsedPullRequest._tag === "err")
      throw new Error("Fixture pull request is invalid");
    return (
      <CanonicalFixtureWorkbench
        data={workbenchFixtureData}
        onNavigationStateChange={onNavigationStateChange}
        modelOverrides={
          detail
            ? {
                conversation: {
                  prDescription: "",
                  entries: [
                    {
                      _tag: "ReviewSummary" as const,
                      review: {
                        id: "published-1",
                        author: "fixture-maintainer",
                        body: "Published review body",
                        event: "COMMENTED" as const,
                        submittedAt: "2026-07-17T00:00:00.000Z",
                        canDismiss: false,
                      },
                    },
                  ],
                },
              }
            : { mergeReadiness, mergeReasons }
        }
        {...(detail
          ? {}
          : {
              mergeAction: {
                readiness,
                mergeReasons,
                pullRequest: parsedPullRequest.value,
                context: {
                  repo: `${workbenchFixtureData.pullRequest.ref.owner}/${workbenchFixtureData.pullRequest.ref.repo}`,
                  prNumber: workbenchFixtureData.pullRequest.ref.number,
                  title: workbenchFixtureData.pullRequest.title,
                  base: workbenchFixtureData.pullRequest.baseBranch,
                  head: workbenchFixtureData.pullRequest.headBranch,
                  headSha: workbenchFixtureData.pullRequest.headSha,
                },
                methods: ["squash", "merge", "rebase"] as const,
                onRecoverMerge: async () => undefined,
                onMerge: async () => ({}),
              },
            })}
      />
    );
  }
  if (hash === "#submission-fixture")
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Use the Review workbench to manage a GitHub pending review.
      </p>
    );
  if (hash === "#merge-fixture")
    return (
      <div className="mx-auto max-w-3xl p-6">
        <CompactMergeCommand
          readiness={{
            _tag: "NeedsAcknowledgement",
            blockers: [],
            warnings: ["request_changes", "high_severity_finding"],
          }}
          context={{
            repo: "centraldigital/patchdesk",
            prNumber: 42,
            title: "Protect review writes",
            base: "sit",
            head: "feat/review",
            headSha: "abcdef1234567890",
          }}
          methods={["squash", "merge"]}
          onRecoverMerge={async () => undefined}
          onMerge={async () => ({ mergeCommitSha: "abcdef" })}
        />
      </div>
    );
  return undefined;
}

function WalkthroughFixture({
  onNavigationStateChange,
}: {
  readonly onNavigationStateChange: (state: NavigationState) => void;
}): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [lifecycle, setLifecycle] = useState<"idle" | "generating" | "ready">(
    "idle",
  );
  const [model, setModel] = useState<string>();
  const [reasoning, setReasoning] = useState<"low" | "medium" | "high">(
    "medium",
  );
  const [generateRequests, setGenerateRequests] = useState(0);
  const [open, setOpen] = useState(false);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const [reviewedSectionIds, setReviewedSectionIds] = useState<
    ReadonlyArray<string>
  >([]);
  const [supportReviewed, setSupportReviewed] = useState(false);
  const walkthrough = useMemo(
    () => ({
      snapshot: {
        profileId: "fixture",
        sessionId: "fixture-session",
        headSha: "abcdef1234567890abcdef1234567890abcdef12",
        patchHash: "b".repeat(64),
      },
      citationStatus: "verified" as const,
      title: "Walkthrough fixture",
      focus: "The focused review path remains separate from Files mode.",
      chapters: [
        {
          id: "chapter-1",
          title: "Read first",
          sections: [
            {
              id: "section-1",
              title: "Keep the review local",
              prose:
                "This fixture proves a manual walkthrough without starting an Analysis run.",
              hunkIds: ["h1"],
              hunks: [
                {
                  id: "h1",
                  path: "src/a.ts",
                  header: "@@ -1 +1 @@",
                  raw: "@@ -1 +1 @@\\n-old\\n+new",
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                },
              ],
            },
            {
              id: "section-2",
              title: "Follow the changed path",
              prose:
                "The chapter rail keeps the next section available without leaving the saved Files surface.",
              hunkIds: ["h2"],
              hunks: [
                {
                  id: "h2",
                  path: "src/b.ts",
                  header: "@@ -1 +1 @@",
                  raw: "@@ -1 +1 @@\\n-old\\n+new",
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                },
              ],
            },
          ],
        },
      ],
      support: {
        id: "support" as const,
        title: "Support" as const,
        hunkIds: ["h3"],
        hunks: [
          {
            id: "h3",
            path: "src/c.ts",
            header: "@@ -1 +1 @@",
            raw: "@@ -1 +1 @@\\n-old\\n+new",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
          },
        ],
      },
    }),
    [],
  );
  const confirmGeneration = (): void => {
    setDialogOpen(false);
    setGenerateRequests((current) => current + 1);
    setLifecycle("generating");
    window.setTimeout(() => setLifecycle("ready"), 50);
  };
  const markSectionReviewed = (sectionId: string): void => {
    setReviewedSectionIds((current) =>
      current.includes(sectionId) ? current : [...current, sectionId],
    );
  };
  return (
    <div data-walkthrough-generate-requests={generateRequests}>
      <WalkthroughFixtureControls
        lifecycle={lifecycle}
        dialogOpen={dialogOpen}
        model={model}
        reasoning={reasoning}
        walkthrough={walkthrough}
        actions={{
          onOpenDialog: () => setDialogOpen(true),
          onCloseDialog: () => setDialogOpen(false),
          onModelChange: (value) => {
            if (value !== null) setModel(value);
          },
          onReasoningChange: (value) => {
            if (value === "low" || value === "medium" || value === "high")
              setReasoning(value);
          },
          onConfirm: confirmGeneration,
          onOpen: () => {
            setOpen(true);
          },
          onMarkSectionReviewed: markSectionReviewed,
          onMarkSupportReviewed: () => setSupportReviewed(true),
          onSelectSection: () => undefined,
        }}
        reviewedSectionIds={reviewedSectionIds}
        supportReviewed={supportReviewed}
        open={open}
        openButtonRef={openButtonRef}
      />
      <CanonicalFixtureWorkbench
        data={{ ...workbenchFixtureData, fullPatch: walkthroughFixturePatch }}
        onNavigationStateChange={onNavigationStateChange}
      />
    </div>
  );
}

function CanonicalFixtureWorkbench({
  data,
  onNavigationStateChange,
  modelOverrides,
  mergeAction,
}: {
  readonly data: typeof workbenchFixtureData;
  readonly onNavigationStateChange: (state: NavigationState) => void;
  readonly modelOverrides?: Partial<
    Pick<WorkbenchResponse, "mergeReadiness" | "mergeReasons" | "conversation">
  >;
  readonly mergeAction?: PullRequestOverviewMerge;
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

export type UnifiedReviewFixtureState =
  | "files-default"
  | "files-commit-selected"
  | "updates-draft"
  | "draft-expanded"
  | "needs-attention"
  | "pr-overview"
  | "merged"
  | "closed"
  | "insights-overview"
  | "analysis-running"
  | "analysis-current"
  | "analysis-outdated"
  | "analysis-failed"
  | "analysis-replacement-running"
  | "analysis-replacement-failed"
  | "walkthrough-current"
  | "walkthrough-outdated"
  | "publication-ready"
  | "publication-publishing"
  | "publication-confirmed"
  | "publication-needs-confirmation"
  | "published-feedback-collapsed"
  | "published-feedback-expanded";

/** Build every design state from one production-shaped Review projection. */
// oxlint-disable-next-line react/only-export-components -- Design bridge consumes the typed fixture factory.
export function unifiedReviewInitialState(
  state: UnifiedReviewFixtureState,
): ReviewWorkbenchInitialState {
  switch (state) {
    case "files-commit-selected":
      return { section: "commits", selectedCommitSha: "b".repeat(40) };
    case "insights-overview":
    case "analysis-running":
    case "analysis-failed":
      return { section: "insights" };
    case "analysis-current":
    case "analysis-outdated":
    case "analysis-replacement-running":
    case "analysis-replacement-failed":
      return { section: "insights", insightDetail: "analysis" };
    case "walkthrough-current":
      return { section: "insights", insightDetail: "walkthrough" };
    case "walkthrough-outdated":
      return { section: "insights", insightDetail: "walkthrough" };
    case "draft-expanded":
      return {
        section: "files",
        selectedPath: "src/a.ts",
        draftExpanded: true,
      };
    case "pr-overview":
      return { section: "files", selectedPath: "src/a.ts", overviewOpen: true };
    default:
      return { section: "files", selectedPath: "src/a.ts" };
  }
}

// oxlint-disable-next-line react/only-export-components -- Design bridge consumes the typed fixture factory.
export function createUnifiedReviewFixture(
  state: UnifiedReviewFixtureState = "files-default",
): WorkbenchResponse {
  const base = canonicalWorkbenchModel(workbenchFixtureData);
  const retainedWalkthrough = fixtureWalkthroughRetention(
    base.session.id,
    base.revision.reviewedHeadSha,
  );
  const withFeedback =
    state === "published-feedback-collapsed" ||
    state === "published-feedback-expanded" ||
    state === "pr-overview" ||
    state === "merged" ||
    state === "closed";
  const analysisFailure = {
    runId: "insight-analysis-1-aaaaaaaaaaaa-review",
    category: "unexpected_failure" as const,
    model: "fixture-model",
    reasoning: "medium" as const,
    retryable: true,
  };
  let analysis: WorkbenchResponse["insights"]["analysis"];
  if (state === "analysis-running") {
    analysis = {
      status: "running",
      activeRun: {
        runId: "analysis-first-run",
        sessionId: base.session.id,
        startedAt: base.revision.refreshedAt,
      },
    };
  } else if (state === "analysis-replacement-running") {
    analysis = {
      ...base.insights.analysis,
      status: "running",
      activeRun: {
        runId: "analysis-replacement-run",
        sessionId: base.session.id,
        startedAt: base.revision.refreshedAt,
      },
    };
  } else if (state === "analysis-failed") {
    analysis = { status: "failed", replacementFailure: analysisFailure };
  } else if (
    state === "analysis-outdated" ||
    state === "analysis-replacement-failed"
  ) {
    analysis = {
      ...base.insights.analysis,
      status: state === "analysis-outdated" ? "outdated" : "failed",
    };
    // Built as a separate statement rather than a conditional spread: only
    // the replacement-failed branch of this already-narrowed state carries
    // `replacementFailure`.
    if (state === "analysis-replacement-failed") {
      analysis = {
        ...analysis,
        replacementFailure: { ...analysisFailure },
      };
    }
  } else if (state === "analysis-current") {
    analysis = { ...base.insights.analysis, status: "current" };
  } else {
    analysis = base.insights.analysis;
  }
  const walkthrough =
    state === "walkthrough-current" || state === "walkthrough-outdated"
      ? {
          status:
            state === "walkthrough-outdated"
              ? ("outdated" as const)
              : ("current" as const),
          retained: retainedWalkthrough,
          progress: { reviewedSectionIds: [], supportReviewed: false },
        }
      : base.insights.walkthrough;
  return {
    ...base,
    review:
      state === "merged"
        ? { id: base.review.id, status: "merged" }
        : state === "closed"
          ? { id: base.review.id, status: "closed" }
          : base.review,
    revision:
      state === "updates-draft" ||
      state === "analysis-outdated" ||
      state === "walkthrough-outdated"
        ? {
            ...base.revision,
            freshness:
              state === "updates-draft"
                ? ("updates_available" as const)
                : base.revision.freshness,
            currentHeadSha: "b".repeat(40),
          }
        : base.revision,
    insights: { analysis, walkthrough },
    conversation: withFeedback
      ? {
          prDescription: base.conversation.prDescription ?? "",
          entries: [
            ...base.conversation.entries,
            {
              _tag: "ReviewSummary" as const,
              review: {
                id: "published-1",
                author: "fixture-maintainer",
                body: "Published review body",
                event: "COMMENTED" as const,
                submittedAt: base.revision.refreshedAt,
                canDismiss: true,
              },
            },
            {
              _tag: "IssueComment" as const,
              comment: {
                id: "comment-1",
                author: "fixture-maintainer",
                body: "Published inline feedback",
                createdAt: base.revision.refreshedAt,
                location: {
                  path: "src/b.ts",
                  line: 1,
                  diffSide: "new" as const,
                },
              },
            },
          ],
        }
      : base.conversation,
  };
}

function fixtureWalkthroughRetention(
  sessionId: string,
  headSha: string,
): NonNullable<WorkbenchResponse["insights"]["walkthrough"]["retained"]> {
  return {
    runId: "walkthrough-fixture",
    sessionId,
    headSha,
    generatedAt: "2026-07-17T00:00:00.000Z",
    value: {
      snapshot: {
        profileId: "fixture",
        sessionId,
        headSha,
        patchHash: "b".repeat(64),
      },
      citationStatus: "verified",
      title: "Walkthrough fixture",
      focus: "Follow the changed path through this Review.",
      chapters: [
        {
          id: "chapter-1",
          title: "Context",
          sections: [
            {
              id: "section-1",
              title: "Keep the review local",
              prose:
                "This stored walkthrough explains the immutable Review revision.",
              hunkIds: ["h1"],
              hunks: [
                {
                  id: "h1",
                  path: "src/a.ts",
                  header: "@@ -1 +1 @@",
                  raw: "@@ -1 +1 @@\\n-old\\n+new",
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                },
              ],
            },
          ],
        },
      ],
      support: { id: "support", title: "Support", hunkIds: [], hunks: [] },
    },
  };
}

function canonicalWorkbenchModel(
  data: typeof workbenchFixtureData,
): WorkbenchResponse {
  const headSha = data.pullRequest.headSha;
  const conversation: WorkbenchResponse["conversation"] = {
    prDescription: "",
    entries: [],
  };
  // Built as a separate statement rather than a conditional spread: most
  // fixtures carry no seeded Conversation threads at all, so `inline` is
  // genuinely absent (not present-with-an-empty-array) for them.
  if (data.conversationThreads.length > 0) {
    // A mutable copy: `data.conversationThreads` is deliberately a
    // `ReadonlyArray`, and the contract's `inline.threads` field is plain
    // `Array`, so this spread relaxes variance without a cast.
    const threads = [...data.conversationThreads];
    conversation.inline = { threads };
  }
  // SAFETY: `data.pullRequest` and `data.result` are deliberately typed with
  // widened `string` fields (not `as const`), not narrowed
  // `WorkbenchResponse` literal unions (e.g. `reviewState`, `verdict`,
  // finding `severity`), so `longWorkbenchFixtureData` below can override one
  // finding via `.map()` without TypeScript treating "index 0" and "index 1"
  // as interchangeable branches of a narrowed union. Every fixture literal's
  // actual string values are already valid members of the narrower target
  // enums; only that intentional widening needs bridging here.
  return {
    state: "review",
    review: { id: "fixture-review", status: "open" },
    session: {
      id: "fixture-session",
      key: {
        profileId: "fixture",
        host: data.pullRequest.ref.host,
        owner: data.pullRequest.ref.owner,
        repo: data.pullRequest.ref.repo,
        prNumber: data.pullRequest.ref.number,
        headSha,
      },
    },
    revision: {
      reviewedHeadSha: headSha,
      currentHeadSha: headSha,
      freshness: "fresh",
      refreshedAt: "2026-07-17T00:00:00.000Z",
    },
    fullPatch: data.fullPatch,
    pullRequest: data.pullRequest,
    commits: data.commits,
    insights: {
      analysis: {
        status: "current",
        retained: {
          runId: "insight-fixture",
          sessionId: "fixture-session",
          headSha,
          generatedAt: "2026-07-17T00:00:00.000Z",
          value: data.result,
        },
      },
      walkthrough: { status: "not_generated" },
    },
    conversation,
    checks: data.checks,
    mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
    mergeReasons: [],
  } as WorkbenchResponse;
}

function WalkthroughFixtureControls({
  lifecycle,
  dialogOpen,
  model,
  reasoning,
  walkthrough,
  actions,
  reviewedSectionIds,
  supportReviewed,
  open,
  openButtonRef,
}: {
  readonly lifecycle: "idle" | "generating" | "ready";
  readonly dialogOpen: boolean;
  readonly model: string | undefined;
  readonly reasoning: "low" | "medium" | "high";
  readonly walkthrough: Parameters<
    typeof NarrativeWalkthrough
  >[0]["walkthrough"];
  readonly actions: {
    readonly onOpenDialog: () => void;
    readonly onCloseDialog: () => void;
    readonly onModelChange: (value: string | null) => void;
    readonly onReasoningChange: (value: string | null) => void;
    readonly onConfirm: () => void;
    readonly onOpen: () => void;
    readonly onMarkSectionReviewed: (sectionId: string) => void;
    readonly onMarkSupportReviewed: () => void;
    readonly onSelectSection: (sectionId: string) => void;
  };
  readonly reviewedSectionIds: ReadonlyArray<string>;
  readonly supportReviewed: boolean;
  readonly open: boolean;
  readonly openButtonRef: React.RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
  return (
    <div className="border-b p-4">
      {lifecycle === "ready" && !open ? (
        <Button ref={openButtonRef} onClick={actions.onOpen}>
          Open walkthrough
        </Button>
      ) : null}
      {lifecycle !== "ready" ? (
        <Button
          onClick={actions.onOpenDialog}
          disabled={lifecycle === "generating"}
        >
          {lifecycle === "generating"
            ? "Generating walkthrough…"
            : "Generate walkthrough"}
        </Button>
      ) : null}
      <Dialog
        open={dialogOpen}
        onOpenChange={(next) =>
          next ? actions.onOpenDialog() : actions.onCloseDialog()
        }
      >
        <DialogContent data-testid="walkthrough-generate-dialog">
          <DialogHeader>
            <DialogTitle>Generate walkthrough</DialogTitle>
            <DialogDescription>
              Choose how Patchdesk should explain this Review.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label
              className="grid gap-1.5 text-sm font-medium"
              htmlFor="fixture-walkthrough-model"
            >
              Model
              <ModelCombobox
                id="fixture-walkthrough-model"
                ariaLabel="Model"
                options={[{ id: "pi-design", label: "Design model" }]}
                value={model ?? null}
                onValueChange={actions.onModelChange}
              />
            </label>
            <label
              className="grid gap-1.5 text-sm font-medium"
              htmlFor="fixture-walkthrough-reasoning"
            >
              Reasoning
              <Select
                value={reasoning}
                onValueChange={actions.onReasoningChange}
              >
                <SelectTrigger
                  id="fixture-walkthrough-reasoning"
                  aria-label="Reasoning"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={actions.onCloseDialog}>
              Cancel
            </Button>
            <Button
              data-testid="walkthrough-confirm"
              disabled={model === undefined}
              onClick={actions.onConfirm}
            >
              Generate walkthrough
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {open ? (
        <NarrativeWalkthrough
          walkthrough={walkthrough}
          reviewedSectionIds={reviewedSectionIds}
          supportReviewed={supportReviewed}
          rawPatch={walkthroughFixturePatch}
          sourceSession={{ profileId: "fixture", sessionId: "fixture-session" }}
          actions={{
            onMarkSectionReviewed: actions.onMarkSectionReviewed,
            onMarkSupportReviewed: actions.onMarkSupportReviewed,
            onSelectSection: actions.onSelectSection,
          }}
        />
      ) : null}
    </div>
  );
}

const fixturePatch = buildFixturePatch();
const walkthroughFixturePatch = `${fixturePatch}diff --git a/src/c.ts b/src/c.ts\n--- a/src/c.ts\n+++ b/src/c.ts\n@@ -1 +1 @@\n-old\n+new\n`;
const activeFollowFixturePatch = buildActiveFollowPatch();
function buildFixturePatch(): string {
  const changedLines = Array.from(
    { length: 48 },
    (_, index) => `-old-${index + 1}\n+new-${index + 1}`,
  ).join("\n");
  return `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,48 +1,48 @@
${changedLines}
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-old
+new
`;
}
function buildActiveFollowPatch(): string {
  return Array.from({ length: 3 }, (_, fileIndex) => {
    const path = `src/${String.fromCharCode(97 + fileIndex)}.ts`;
    const lines = Array.from(
      { length: 48 },
      (_, lineIndex) =>
        `-old-${fileIndex}-${lineIndex}\n+new-${fileIndex}-${lineIndex}`,
    ).join("\n");
    return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,48 +1,48 @@\n${lines}\n`;
  }).join("");
}

// oxlint-disable-next-line react/only-export-components -- Design reuses this deterministic completed-workbench payload.
export const workbenchFixtureData = {
  fullPatch: fixturePatch,
  pullRequest: {
    ref: {
      host: "github.com",
      owner: "centraldigital",
      repo: "patchdesk",
      number: 42,
    },
    title: "Protect review writes",
    description:
      "## Review path\n\n<details open><summary>Deployment notes</summary><p>Keep this preview readable.</p></details>\n\n```mermaid\ngraph TD\n  A[Open] --> B[Review]\n```",
    author: "fixture",
    headBranch: "feat/review",
    baseBranch: "sit",
    headSha: "abcdef1234567890abcdef1234567890abcdef12",
    isOpen: true,
    isDraft: false,
    reviewState: "none",
    mergeability: "mergeable",
    labels: [],
    updatedAt: "2026-07-17T00:00:00.000Z",
  },
  result: {
    changeSummary: "Review completed for Patchdesk workbench",
    verdict: "comment",
    summary: "One mapped finding and one finding that needs manual placement.",
    findings: [
      {
        id: "mapped",
        severity: "P1",
        title: "Keep writes behind the stale-head check",
        file: "src/b.ts",
        lineStart: 1,
        diffSide: "new",
        explanation:
          "A GitHub adapter must never bypass the current head check.",
        suggestedComment: "Keep the stale-head check at the write boundary.",
        confidence: "high",
        mappingStatus: "mapped",
      },
      {
        id: "unmapped",
        severity: "P2",
        title: "Document the manual placement",
        explanation: "This review point has no verified diff coordinate.",
        confidence: "medium",
        mappingStatus: "unmapped",
      },
    ],
    validationPlan: [
      "pnpm test -- --run review-workbench",
      "pnpm test:e2e -- --grep completed-review",
    ],
    assumptions: [
      "The head SHA remains current while this Review is inspected.",
    ],
  },

  commits: [
    {
      sha: "b".repeat(40),
      message: "Preserve review write coordination",
      author: "fixture",
      authoredAt: "2026-07-17T00:00:00.000Z",
      isHead: true,
    },
    {
      sha: "a".repeat(40),
      message: "Add review workbench",
      author: "fixture",
      authoredAt: "2026-07-16T00:00:00.000Z",
      isHead: false,
    },
  ],
  comments: {
    threads: [
      {
        id: "thread-1",
        state: "open" as const,
        location: { path: "src/b.ts", line: 1 },
        comments: [
          {
            id: "comment-1",
            author: "reviewer",
            body: "Existing GitHub review comment.",
            createdAt: "2026-07-16T00:00:00.000Z",
            url: "https://github.com/centraldigital/patchdesk/pull/1#discussion_r1",
          },
        ],
      },
    ],
  },
  checks: {
    overall: "failing" as const,
    checks: [
      {
        name: "unit",
        required: true as const,
        status: "completed" as const,
        conclusion: "failure" as const,
        url: "https://github.com/centraldigital/patchdesk/actions/runs/1",
      },
      { name: "docs", required: false as const, status: "queued" as const },
    ],
  },
  conversationThreads: noConversationThreads,
};
// Threads placed for the browser suite's Threads-navigator coverage: one new-
// side single line, one old-side single line, one multi-line range, and one
// in src/c.ts -- the third file of `activeFollowFixturePatch`, which the
// diff's progressive loading leaves un-hydrated until scrolled to (see
// "streamed files can become the passive active path" above), so selecting
// it exercises the same progressive-materialization path a deep file-tree
// jump does.
const activeFollowFixtureConversationThreads: ReadonlyArray<FixtureConversationThread> =
  [
    {
      // Kept in src/a.ts -- the file the diff already shows before any
      // selection -- but deep enough (line 45 of 48) that centering the
      // target row still forces the viewport to scroll away from its
      // initial scrollTop: 0 render, rather than landing on a position
      // close enough to 0 that a real regression could hide behind it.
      id: "thread-new-side",
      state: "open",
      location: { path: "src/a.ts", line: 45, diffSide: "new" },
      comments: [
        {
          id: "comment-new-side",
          author: "new-side-thread-author",
          body: "New-side thread body.",
          createdAt: "2026-07-17T00:00:00.000Z",
        },
      ],
    },
    {
      id: "thread-old-side",
      state: "open",
      location: { path: "src/b.ts", line: 12, diffSide: "old" },
      comments: [
        {
          id: "comment-old-side",
          author: "old-side-thread-author",
          body: "Old-side thread body.",
          createdAt: "2026-07-17T00:00:00.000Z",
        },
      ],
    },
    {
      id: "thread-multiline",
      state: "open",
      location: { path: "src/b.ts", line: 30, lineEnd: 33, diffSide: "new" },
      comments: [
        {
          id: "comment-multiline",
          author: "multiline-thread-author",
          body: "Multi-line thread body.",
          createdAt: "2026-07-17T00:00:00.000Z",
        },
      ],
    },
    {
      id: "thread-deep-file",
      state: "open",
      location: { path: "src/c.ts", line: 30, diffSide: "new" },
      comments: [
        {
          id: "comment-deep-file",
          author: "deep-file-thread-author",
          body: "Deep-file thread body.",
          createdAt: "2026-07-17T00:00:00.000Z",
        },
      ],
    },
  ];
const activeFollowFixtureData = {
  ...workbenchFixtureData,
  fullPatch: activeFollowFixturePatch,
  conversationThreads: activeFollowFixtureConversationThreads,
};
const longFixturePath =
  "src/features/review-workbench/components/extremely-long-directory-name-without-shortcuts/authoritative-review-write-coordination-and-recovery-surface.ts";
const longFixtureTitle =
  "Protect the authoritative review write boundary when a pull request title contains localized text, identifiers, and enough detail to exceed the available header width";
const longWorkbenchFixtureData = {
  ...workbenchFixtureData,
  fullPatch: `diff --git a/${longFixturePath} b/${longFixturePath}\n--- a/${longFixturePath}\n+++ b/${longFixturePath}\n@@ -1 +1 @@\n-old\n+new\n`,
  pullRequest: {
    ...workbenchFixtureData.pullRequest,
    ref: {
      ...workbenchFixtureData.pullRequest.ref,
      owner: "centraldigital-platform-engineering-maintainers",
      repo: "patchdesk-desktop-review-workbench-with-a-long-repository-name",
    },
    title: longFixtureTitle,
    author: "reviewer-with-a-long-github-handle-for-layout-validation",
    headBranch:
      "feat/CFW-1234-preserve-authoritative-review-coordination-across-desktop-restarts",
    baseBranch: "release/2026-07-operational-readiness-and-accessibility",
  },
  result: {
    ...workbenchFixtureData.result,
    findings: workbenchFixtureData.result.findings.map((finding, index) =>
      index === 0
        ? {
            ...finding,
            file: longFixturePath,
            title:
              "Keep every pending GitHub write attached to the exact authoritative revision even when the finding title is unusually descriptive",
            explanation:
              "This deliberately long explanation proves that detailed review guidance wraps without making the action rail or navigation pane wider than the viewport.",
          }
        : finding,
    ),
    validationPlan: [
      "pnpm test -- --run tests/services/review-write-controller-with-authoritative-revision-and-recovery.test.ts",
      "pnpm test:e2e -- --grep completed-review-long-localized-content-and-responsive-navigation",
      "authoritativeReviewWriteCoordinationAndRecoverySurfaceWithoutNaturalBreakpointsMustRemainReadableInsideTheInspector",
    ],
  },
  comments: {
    threads: workbenchFixtureData.comments.threads.map((thread) => ({
      ...thread,
      location: { path: longFixturePath, line: 1 },
      comments: thread.comments.map((comment) => ({
        ...comment,
        author: "reviewer-with-a-long-github-handle-for-layout-validation",
        body: "Existing GitHub review comment with enough detail to wrap across several lines while retaining the complete author, timestamp, and discussion content for assistive technology.",
      })),
    })),
  },
  checks: {
    ...workbenchFixtureData.checks,
    checks: workbenchFixtureData.checks.checks.map((check, index) =>
      index === 0
        ? {
            ...check,
            name: "required-review-workbench-authoritative-write-and-restart-recovery-validation",
          }
        : check,
    ),
  },
};
// oxlint-disable-next-line react/only-export-components -- Design reuses this deterministic submission payload.
export const submissionFixtureData = {
  batch: {
    sessionId:
      "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__abcdefabcdef",
    state: { _tag: "Local" as const },
    summaryBody: "Request changes before merge.",
    suggestedEvent: "COMMENT" as const,
    items: [
      {
        _tag: "InlineComment" as const,
        id: "p1",
        provenance: { _tag: "human" as const },
        source: "manual" as const,
        include: true,
        anchor: {
          path: "src/services/review-submission-service.ts",
          startLine: 34,
          line: 34,
          side: "new" as const,
        },
        body: "Keep the stale-head check at the write boundary.",
        postability: "postable",
      },
    ],
    receipts: [],
    createdAt: "2026-07-18T10:00:00.000Z",
    updatedAt: "2026-07-18T10:00:00.000Z",
  },
};
