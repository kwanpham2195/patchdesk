import { useCallback, useEffect, useRef, useState } from "react";
import { DiffWorkbench } from "./components/diff-workbench";
import { AppShell } from "./components/app-shell";
import {
  MaintainerInbox,
  type ReviewStartMode,
} from "./components/maintainer-inbox";
import { ReviewWorkbench } from "./components/review-workbench";
import { ReviewSubmissionDialog } from "./components/review-submission-dialog";
import { MergeConfirmationDialog } from "./components/merge-confirmation-dialog";
import { SafeRunPanel } from "./components/safe-run-panel";
import { TooltipProvider } from "./components/ui/tooltip";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog";
import { Skeleton } from "./components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import type { AppDestination } from "./routes";
import { destinationKey, parseDestination } from "./routes";
import { PatchdeskApiError, requestJson, selectDirectory } from "./api-client";
import { parseInboxResponse, parseWorkbenchResponse, type InboxResponse } from "./renderer-contracts";

export type DashboardScreenState =
  | "empty"
  | "loading"
  | "success"
  | "degraded"
  | "error"
  | "archived"
  | "no_open_prs";
export type AppProps = { readonly initialState?: DashboardScreenState };
type Profile = {
  readonly id: string;
  readonly label: string;
  readonly githubHost: string;
  readonly ghAccount: string;
  readonly workspaceRoots?: ReadonlyArray<string>;
};
type Repo = {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly localPath?: string;
  readonly archived?: boolean;
};
type RepoOutcome = { readonly repo: Repo; readonly state: string };
type PrRow = {
  readonly summary: {
    readonly ref: {
      readonly host: string;
      readonly owner: string;
      readonly repo: string;
      readonly number: number;
    };
    readonly title: string;
    readonly author: string;
    readonly checkSummary?: { readonly overall: string };
  };
  readonly priority: string;
  readonly badges: ReadonlyArray<string>;
};
type Dashboard = {
  readonly profile: Profile;
  readonly dashboard: {
    readonly rows: ReadonlyArray<PrRow>;
    readonly repos: ReadonlyArray<RepoOutcome>;
  };
};
type Preview = {
  readonly pr: {
    readonly host?: string;
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  };
  readonly confirmation: {
    readonly required: boolean;
    readonly targetProfileId?: string;
  };
};
type WorkbenchPayload = {
  readonly state: "review_started" | "completed";
  readonly session: {
    readonly id: string;
    readonly key: {
      readonly profileId: string;
      readonly owner: string;
      readonly repo: string;
      readonly prNumber: number;
      readonly headSha: string;
    };
    readonly currentAttemptId?: string;
    readonly draftContent?: unknown;
  };
  readonly result?: unknown;
  readonly draft?: unknown;
  readonly comments?: unknown;
  readonly checks?: unknown;
  readonly history?: unknown;
  readonly mergeReadiness?: unknown;
  readonly runId?: string;
  readonly reviewScope?: unknown;
  readonly fullPatch?: string;
  readonly comparison?: unknown;
  readonly comparisonPatch?: string;
  readonly lifecycle?: unknown;
  readonly comparisonAvailability?: "available" | "not_requested" | "incomplete" | "missing";
  readonly pullRequest?: {
    readonly ref: {
      readonly owner: string;
      readonly repo: string;
      readonly number: number;
    };
    readonly title: string;
    readonly author: string;
    readonly headBranch: string;
    readonly baseBranch: string;
    readonly headSha: string;
  };
  readonly reviewedHeadSha?: string;
  readonly currentHeadSha?: string;
  readonly freshness?: "fresh" | "stale" | "unavailable";
  readonly refreshedAt?: string;
};
type ReviewRecord = {
  readonly id: string;
  readonly profileId: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly title?: string;
  readonly state: string;
  readonly draftState?: string;
  readonly updatedAt: string;
};

/** Renderer-only dashboard: every product value is loaded from the authenticated local API. */
export function App({ initialState }: AppProps): React.JSX.Element {
  const diffFixture =
    typeof window !== "undefined" && window.location.hash === "#diff-fixture";
  const runFixture =
    typeof window !== "undefined" && window.location.hash === "#run-fixture";
  const workbenchFixture =
    typeof window !== "undefined" &&
    ["#workbench-fixture", "#long-workbench-fixture"].includes(
      window.location.hash,
    );
  const longWorkbenchFixture =
    typeof window !== "undefined" &&
    window.location.hash === "#long-workbench-fixture";
  const performanceFixture =
    typeof window !== "undefined" &&
    window.location.hash === "#performance-fixture";
  const submissionFixture =
    typeof window !== "undefined" &&
    window.location.hash === "#submission-fixture";
  const submissionRejectionFixture =
    typeof window !== "undefined" &&
    window.location.hash === "#submission-rejection-fixture";
  const mergeFixture =
    typeof window !== "undefined" && window.location.hash === "#merge-fixture";
  const fixtureMode =
    diffFixture ||
    runFixture ||
    workbenchFixture ||
    performanceFixture ||
    submissionFixture ||
    submissionRejectionFixture ||
    mergeFixture;
  const [destination, setDestination] = useState<AppDestination>(() =>
    parseDestination(
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem("patchdesk.destination"),
    ),
  );
  const [profiles, setProfiles] = useState<ReadonlyArray<Profile>>([]);
  const [dashboard, setDashboard] = useState<Dashboard | undefined>();
  const [inbox, setInbox] = useState<InboxResponse | undefined>();
  const [state, setState] = useState<DashboardScreenState>(
    initialState ?? "loading",
  );
  const [reference, setReference] = useState("");
  const [preview, setPreview] = useState<Preview | undefined>();
  const [openedPr, setOpenedPr] = useState<string | undefined>();
  const [openError, setOpenError] = useState<string | undefined>();
  const [workbench, setWorkbench] = useState<WorkbenchPayload | undefined>();
  const [newRepo, setNewRepo] = useState("");
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [pathFeedback, setPathFeedback] = useState<string>();
  const [suggestions, setSuggestions] = useState<ReadonlyArray<Repo>>([]);
  const [githubAccess, setGithubAccess] = useState<string | undefined>();
  const [environment, setEnvironment] = useState<Record<string, string>>();
  const [reviewRecords, setReviewRecords] = useState<
    ReadonlyArray<ReviewRecord>
  >([]);
  const [reviewRecordsState, setReviewRecordsState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [invalidReviewRecordCount, setInvalidReviewRecordCount] = useState(0);
  const restoredSessionId = useRef<string | undefined>(undefined);
  const [navigationState, setNavigationState] = useState<
    "clear" | "dirty_draft" | "write_pending"
  >("clear");
  const [pendingDestination, setPendingDestination] =
    useState<AppDestination>();
  const keepProfileButton = useRef<HTMLButtonElement | null>(null);
  const previewTrigger = useRef<HTMLElement | null>(null);
  const [profileDraft, setProfileDraft] = useState({
    id: "",
    label: "",
    githubHost: "github.com",
    ghAccount: "",
    workspaceRoot: "",
  });
  const loadEnvironment = useCallback(async (): Promise<void> => {
    const value = await api("/v1/environment");
    if (record(value)) {
      setEnvironment(
        Object.fromEntries(
          Object.entries(value).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
      );
    }
  }, []);
  const loadCompletedWorkbench = useCallback(
    async (profileId: string, sessionId: string): Promise<void> => {
      const value = await api("/v1/reviews/load", {
        method: "POST",
        body: { profileId, sessionId },
      });
      if (isWorkbenchPayload(value)) setWorkbench(value);
    },
    [],
  );
  const loadReviewRecords = useCallback(
    async (profileId: string): Promise<void> => {
      setReviewRecordsState("loading");
      setInvalidReviewRecordCount(0);
      try {
        const value = await api(
          `/v1/reviews?profileId=${encodeURIComponent(profileId)}`,
        );
        if (!record(value) || !Array.isArray(value.sessions))
          throw new Error("Invalid local review response");
        const valid = value.sessions.filter(isReviewRecord);
        setReviewRecords(valid);
        setInvalidReviewRecordCount(value.sessions.length - valid.length);
        setReviewRecordsState("ready");
      } catch {
        setReviewRecordsState("error");
      }
    },
    [],
  );

  const load = async (
    options: { readonly preserveProfileDraft?: boolean } = {},
  ): Promise<void> => {
    if (typeof window === "undefined" || !("patchdesk" in window)) {
      setState(initialState ?? "empty");
      return;
    }
    setState("loading");
    let profilePayload: unknown;
    let dashboardPayload: unknown;
    try {
      profilePayload = await api("/v1/profiles");
      try {
        dashboardPayload = await api("/v1/inbox");
      } catch (error: unknown) {
        // Compatibility is intentionally limited to an older main process
        // that does not expose the inbox endpoint. A real inbox failure must
        // remain visible and retryable instead of showing stale dashboard data.
        if (!(error instanceof PatchdeskApiError) || error.status !== 404)
          throw error;
        dashboardPayload = await api("/v1/dashboard");
      }
    } catch {
      setState("error");
      return;
    }
    if (Array.isArray(profilePayload))
      setProfiles(profilePayload.filter(isProfile));
    const loadedInbox = parseInboxResponse(dashboardPayload);
    const compatibleDashboard = loadedInbox === undefined
      ? isDashboard(dashboardPayload)
        ? dashboardPayload
        : undefined
      : dashboardFromInbox(loadedInbox);
    if (compatibleDashboard !== undefined) {
      if (loadedInbox !== undefined) setInbox(loadedInbox);
      setDashboard(compatibleDashboard);
      if (options.preserveProfileDraft !== true) {
        setProfileDraft({
          id: compatibleDashboard.profile.id,
          label: compatibleDashboard.profile.label,
          githubHost: compatibleDashboard.profile.githubHost,
          ghAccount: compatibleDashboard.profile.ghAccount,
          workspaceRoot: compatibleDashboard.profile.workspaceRoots?.[0] ?? "",
        });
      }
      const outcomes = compatibleDashboard.dashboard.repos.map(
        (item) => item.state,
      );
      setState(
        outcomes.includes("github_auth") || outcomes.includes("github_read")
          ? "error"
          : outcomes.includes("archived")
            ? "archived"
            : outcomes.includes("no_open_prs") &&
                compatibleDashboard.dashboard.rows.length === 0
              ? "no_open_prs"
              : outcomes.includes("missing_local_path")
                ? "degraded"
                : compatibleDashboard.dashboard.rows.length === 0
                  ? "empty"
                  : "success",
      );
    } else if (initialState === undefined) setState("empty");
  };
  useEffect(() => {
    if (!fixtureMode) void load();
  }, [fixtureMode]);
  useEffect(() => {
    if (
      (destination.kind !== "drafts" && destination.kind !== "history") ||
      dashboard === undefined
    )
      return;
    void loadReviewRecords(dashboard.profile.id);
  }, [dashboard, destination.kind, loadReviewRecords]);
  useEffect(() => {
    if (destination.kind === "settings") void loadEnvironment();
  }, [destination.kind, loadEnvironment]);
  useEffect(() => {
    if (fixtureMode || typeof window.patchdesk?.request !== "function") return;
    void window.patchdesk
      .request({ operation: "setNavigationState", state: navigationState })
      .catch(() => undefined);
  }, [fixtureMode, navigationState]);
  useEffect(() => {
    if (
      destination.kind !== "workbench" ||
      dashboard === undefined ||
      workbench !== undefined ||
      restoredSessionId.current === destination.sessionId
    )
      return;
    restoredSessionId.current = destination.sessionId;
    void loadCompletedWorkbench(dashboard.profile.id, destination.sessionId);
  }, [dashboard, destination, loadCompletedWorkbench, workbench]);

  const performNavigation = useCallback((next: AppDestination): void => {
    if (next.kind !== "workbench") setWorkbench(undefined);
    setDestination(next);
    window.localStorage.setItem("patchdesk.destination", destinationKey(next));
  }, []);
  const navigate = useCallback(
    (next: AppDestination): void => {
      if (destinationKey(next) === destinationKey(destination)) return;
      if (navigationState !== "clear") {
        setPendingDestination(next);
        return;
      }
      performNavigation(next);
    },
    [destination, navigationState, performNavigation],
  );
  useEffect(() => {
    if (fixtureMode || typeof window.patchdesk?.onNavigate !== "function")
      return;
    return window.patchdesk.onNavigate((next) => {
      if (next === "settings") navigate({ kind: "settings" });
    });
  }, [fixtureMode, navigate]);

  const shell = (
    content: React.ReactNode,
    next: AppDestination = destination,
  ): React.JSX.Element => (
    <TooltipProvider>
      <AppShell
        destination={next}
        profileId={dashboard?.profile.id ?? "default"}
        profileLabel={dashboard?.profile.label ?? "Local workspace"}
        repositoryCount={dashboard?.dashboard.repos.length ?? 0}
        navigationBlocked={navigationState !== "clear"}
        onNavigate={navigate}
        workspacePanel={
          dashboard === undefined ? undefined : (
            <section aria-labelledby="watchlist-title">
              <h2
                id="watchlist-title"
                className="px-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
              >
                Watchlist
              </h2>
              <div className="mt-2 space-y-1">
                {dashboard.dashboard.repos.map(({ repo, state: outcome }) => (
                  <div
                    key={key(repo)}
                    className="rounded-md px-2 py-1.5 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-medium">
                        {repo.owner}/{repo.repo}
                      </span>
                      <Badge
                        variant={outcome === "ready" ? "secondary" : "outline"}
                        className="shrink-0"
                      >
                        {outcome.replaceAll("_", " ")}
                      </Badge>
                    </div>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="mt-1"
                      aria-label={`Refresh ${repo.owner}/${repo.repo}`}
                      onClick={() => void refreshRepo(repo)}
                    >
                      Refresh repo
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          )
        }
      >
        {content}
      </AppShell>
      <AlertDialog
        open={pendingDestination !== undefined}
        onOpenChange={(open) => {
          if (!open && navigationState !== "write_pending")
            setPendingDestination(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {navigationState === "write_pending"
                ? "A GitHub write is still in progress"
                : "Leave with an unsaved review draft?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {navigationState === "write_pending"
                ? "Patchdesk must receive the final result before navigation can continue."
                : "Your latest text has not been saved. Stay to save it, or discard only this unsaved local edit."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {navigationState === "write_pending"
                ? "Wait for completion"
                : "Stay on this review"}
            </AlertDialogCancel>
            {navigationState === "write_pending" ? null : (
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  if (pendingDestination !== undefined)
                    performNavigation(pendingDestination);
                  setNavigationState("clear");
                  setPendingDestination(undefined);
                }}
              >
                Discard changes and leave
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );

  if (diffFixture)
    return shell(
      <DiffWorkbench
        patch={fixturePatch}
        finding={{ file: "src/b.ts", lineStart: 1, diffSide: "new" }}
      />,
      { kind: "workbench", sessionId: "fixture" },
    );
  if (performanceFixture)
    return shell(
      <DiffWorkbench
        patch={buildLargePatchFixture()}
        finding={{
          file: "src/generated/file-0999.ts",
          lineStart: 1,
          diffSide: "new",
        }}
      />,
      { kind: "workbench", sessionId: "performance-fixture" },
    );
  if (runFixture)
    return shell(
      <div className="p-6">
        <RunFixturePanel />
      </div>,
      { kind: "workbench", sessionId: "fixture-session" },
    );
  if (workbenchFixture) {
    const fixture = longWorkbenchFixture
      ? longWorkbenchFixtureData
      : workbenchFixtureData;
    return shell(
      <ReviewWorkbench
        profileId="fixture"
        result={fixture.result as never}
        fullPatch={fixture.fullPatch}
        pullRequest={fixture.pullRequest as never}
        reviewedHeadSha="abcdef1234567890abcdef1234567890abcdef12"
        freshness="fresh"
        refreshedAt="2026-07-17T00:00:00.000Z"
        draft={workbenchFixtureData.draft}
        draftEditor={{
          draft: workbenchFixtureData.editableDraft as never,
          onSave: async (input) => {
            const draft = {
              ...workbenchFixtureData.editableDraft,
              summaryBody: input.summaryBody,
              comments: workbenchFixtureData.editableDraft.comments.map(
                (comment) => {
                  const edited = input.comments.find(
                    (candidate) => candidate.findingId === comment.findingId,
                  );
                  return edited === undefined
                    ? comment
                    : {
                        ...comment,
                        include: edited.include,
                        body: edited.body,
                      };
                },
              ),
              updatedAt: "2026-07-17T00:00:01.000Z",
            };
            return { draft: draft as never, revision: draft.updatedAt };
          },
        }}
        comments={fixture.comments as never}
        checks={fixture.checks}
        history={workbenchFixtureData.history}
        debugHref={workbenchFixtureData.debugHref}
      />,
      { kind: "workbench", sessionId: "fixture-session" },
    );
  }
  if (submissionFixture)
    return shell(
      <div className="mx-auto max-w-3xl p-6">
        <ReviewSubmissionDialog
          draft={submissionFixtureData.draft as never}
          findings={submissionFixtureData.findings as never}
          onCreatePending={async () => ({ reviewId: "9001" })}
          onSubmitPending={async () => ({ reviewId: "9001" })}
        />
      </div>,
      { kind: "workbench", sessionId: "fixture-session" },
    );
  if (submissionRejectionFixture)
    return shell(
      <div className="mx-auto max-w-3xl p-6">
        <ReviewSubmissionDialog
          draft={submissionFixtureData.draft as never}
          findings={submissionFixtureData.findings as never}
          onCreatePending={async () => {
            throw new Error("fixture rejection");
          }}
          onSubmitPending={async () => ({ reviewId: "9001" })}
        />
      </div>,
      { kind: "workbench", sessionId: "fixture-session" },
    );
  if (mergeFixture)
    return shell(
      <div className="mx-auto max-w-3xl p-6">
        <MergeConfirmationDialog
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
          onMerge={async () => ({ mergeCommitSha: "abcdef" })}
        />
      </div>,
      { kind: "workbench", sessionId: "fixture-session" },
    );

  if (workbench?.state === "review_started")
    return shell(
      <section
        className="mx-auto max-w-3xl p-6"
        aria-label="Review in progress"
      >
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-[.16em] text-primary">
            Review session started
          </p>
          <h1 className="mt-2 text-2xl font-semibold">
            Preparing the persisted review workbench
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Session {workbench.session.id}
          </p>
          {workbench.session.currentAttemptId === undefined ? (
            <p className="mt-3 text-sm text-muted-foreground">
              The review has been recorded locally and will appear here when its
              result is complete.
            </p>
          ) : (
            <SafeRunPanel
              profileId={workbench.session.key.profileId}
              sessionId={workbench.session.id}
              attemptId={workbench.session.currentAttemptId}
              {...(workbench.runId === undefined
                ? {}
                : { runId: workbench.runId })}
              onStart={async () =>
                startOwnedRun(
                  workbench.session.key.profileId,
                  workbench.session.id,
                  workbench.session.currentAttemptId ?? "",
                )
              }
              onCompleted={loadCompletedWorkbench}
            />
          )}
        </div>
      </section>,
      { kind: "workbench", sessionId: workbench.session.id },
    );

  if (workbench?.state === "completed" && dashboard !== undefined) {
    const draftView = workbench.draft as
      | {
          readonly summaryBody?: string;
          readonly comments?: ReadonlyArray<{
            readonly findingId: string;
            readonly body: string;
            readonly postability: "postable";
          }>;
        }
      | undefined;
    const merge =
      workbench.pullRequest === undefined ||
      workbench.mergeReadiness === undefined
        ? undefined
        : {
            readiness: workbench.mergeReadiness as never,
            context: {
              repo: `${workbench.pullRequest.ref.owner}/${workbench.pullRequest.ref.repo}`,
              prNumber: workbench.pullRequest.ref.number,
              title: workbench.pullRequest.title,
              base: workbench.pullRequest.baseBranch,
              head: workbench.pullRequest.headBranch,
              headSha: workbench.pullRequest.headSha,
            },
            methods: ["squash", "merge", "rebase"] as const,
            onMerge: async (
              method: "squash" | "merge" | "rebase",
              acknowledgedWarnings: boolean,
            ) => mergeReview(method, acknowledgedWarnings),
          };
    return shell(
      <ReviewWorkbench
        profileId={workbench.session.key.profileId}
        result={workbench.result as never}
        {...(workbench.reviewScope === undefined ? {} : { reviewScope: workbench.reviewScope as never })}
        {...(workbench.fullPatch === undefined ? {} : { fullPatch: workbench.fullPatch })}
        {...(workbench.comparison === undefined ? {} : { comparison: workbench.comparison as never })}
        {...(workbench.comparisonPatch === undefined ? {} : { comparisonPatch: workbench.comparisonPatch })}
        {...(workbench.lifecycle === undefined ? {} : { lifecycle: workbench.lifecycle as never })}
        {...(workbench.comparisonAvailability === undefined ? {} : { comparisonAvailability: workbench.comparisonAvailability })}
        {...(workbench.pullRequest === undefined
          ? {}
          : { pullRequest: workbench.pullRequest as never })}
        {...(workbench.reviewedHeadSha === undefined
          ? {}
          : { reviewedHeadSha: workbench.reviewedHeadSha })}
        {...(workbench.currentHeadSha === undefined
          ? {}
          : { currentHeadSha: workbench.currentHeadSha })}
        {...(workbench.freshness === undefined
          ? {}
          : { freshness: workbench.freshness })}
        {...(workbench.refreshedAt === undefined
          ? {}
          : { refreshedAt: workbench.refreshedAt })}
        draft={{
          summaryBody: draftView?.summaryBody ?? "",
          comments: draftView?.comments ?? [],
        }}
        comments={workbench.comments as never}
        checks={workbench.checks as never}
        history={(workbench.history as never) ?? []}
        debugHref={`/debug/${workbench.session.id}`}
        onNavigationStateChange={setNavigationState}
        draftEditor={{ draft: workbench.draft as never, onSave: saveDraft }}
        submission={{
          draft: workbench.draft as never,
          onCreatePending: async () => reviewWrite("/v1/reviews/pending"),
          onSubmitPending: async (event) =>
            reviewWrite("/v1/reviews/submit", { event }),
        }}
        {...(merge === undefined ? {} : { merge })}
      />,
      { kind: "workbench", sessionId: workbench.session.id },
    );
  }

  const select = async (id: string): Promise<void> => {
    const selected = profiles.find((profile) => profile.id === id);
    if (selected !== undefined) {
      setProfileDraft({
        id: selected.id,
        label: selected.label,
        githubHost: selected.githubHost,
        ghAccount: selected.ghAccount,
        workspaceRoot: selected.workspaceRoots?.[0] ?? "",
      });
      setDashboard((current) =>
        current === undefined ? current : { ...current, profile: selected },
      );
    }
    await api("/v1/profiles/select", { method: "POST", body: { id } });
    await load({ preserveProfileDraft: true });
  };
  const refreshDashboard = async (): Promise<void> => {
    await api("/v1/inbox/refresh", { method: "POST" });
    await load();
  };
  const refreshRepo = async (repo: Repo): Promise<void> => {
    await api("/v1/dashboard/refresh/repository", {
      method: "POST",
      body: repo,
    });
    await load();
  };
  const saveProfile = async (): Promise<void> => {
    const exists = profiles.some((profile) => profile.id === profileDraft.id);
    await api("/v1/profiles", {
      method: exists ? "PUT" : "POST",
      body: {
        ...profileDraft,
        workspaceRoots:
          profileDraft.workspaceRoot.trim().length === 0
            ? []
            : [profileDraft.workspaceRoot.trim()],
      },
    });
    await load();
  };
  const addRepo = async (): Promise<void> => {
    const match = /^([^/]+)\/([^/]+)$/.exec(newRepo.trim());
    if (match === null) return;
    await api("/v1/watchlist", {
      method: "POST",
      body: {
        host: dashboard?.profile.githubHost ?? "github.com",
        owner: match[1],
        repo: match[2],
      },
    });
    setNewRepo("");
    await load();
  };
  const editPath = async (repo: Repo): Promise<void> => {
    await api("/v1/watchlist/path", {
      method: "PATCH",
      body: { ...repo, localPath: paths[key(repo)] ?? repo.localPath ?? "" },
    });
    await load();
  };
  const choosePath = async (repo: Repo): Promise<void> => {
    const selected = await selectDirectory(paths[key(repo)] ?? repo.localPath);
    if (selected === undefined) {
      setPathFeedback(
        "Folder selection cancelled. The existing repository path was not changed.",
      );
      return;
    }
    setPaths((current) => ({ ...current, [key(repo)]: selected }));
    setPathFeedback(
      `Selected ${selected} for ${repo.owner}/${repo.repo}. Save the path to apply it.`,
    );
  };
  const remove = async (repo: Repo): Promise<void> => {
    await api("/v1/watchlist", { method: "DELETE", body: repo });
    await load();
  };
  const archive = async (repo: Repo): Promise<void> => {
    await api("/v1/watchlist/archive", {
      method: "PATCH",
      body: { ...repo, archived: repo.archived !== true },
    });
    await load();
  };
  const discover = async (): Promise<void> => {
    const value = await api("/v1/watchlist/suggestions");
    if (Array.isArray(value)) setSuggestions(value.filter(isRepo));
  };
  const addSuggestion = async (repo: Repo): Promise<void> => {
    await api("/v1/watchlist", { method: "POST", body: repo });
    setSuggestions((current) =>
      current.filter((item) => key(item) !== key(repo)),
    );
    await load();
  };
  const testGitHubAccess = async (): Promise<void> => {
    const value = await api("/v1/github/access", { method: "POST" });
    if (record(value) && typeof value.state === "string")
      setGithubAccess(value.state);
  };
  const checkEnvironment = async (): Promise<void> => {
    await loadEnvironment();
  };
  const previewEntry = async (): Promise<void> => {
    previewTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const value = await api("/v1/direct-entry/preview", {
      method: "POST",
      body: { reference },
    });
    if (!isPreview(value)) return;
    if (value.confirmation.required) {
      setPreview(value);
      return;
    }
    await openPullRequest(value.pr);
  };
  const confirmEntry = async (): Promise<void> => {
    if (preview === undefined) return;
    if (preview.confirmation.targetProfileId !== undefined)
      await select(preview.confirmation.targetProfileId);
    await openPullRequest(preview.pr);
    setPreview(undefined);
  };
  async function openPullRequest(
    pr: Preview["pr"],
    mode: ReviewStartMode = "full",
    baseSessionId?: string,
  ): Promise<void> {
    setOpenedPr(undefined);
    setOpenError(undefined);
    try {
      const value = await api("/v1/reviews/open", {
        method: "POST",
        body: {
          profileId:
            dashboard?.profile.id ||
            (profileDraft.id.trim().length === 0 ? undefined : profileDraft.id),
          host: pr.host ?? dashboard?.profile.githubHost ?? profileDraft.githubHost,
          owner: pr.owner,
          repo: pr.repo,
          number: pr.number,
          mode,
          ...(baseSessionId === undefined ? {} : { baseSessionId }),
        },
      });
      if (!isWorkbenchPayload(value))
        throw new Error("invalid workbench projection");
      const runId =
        value.state === "review_started" &&
        value.session.currentAttemptId !== undefined
          ? await startRun(
              value.session.key.profileId,
              value.session.id,
              value.session.currentAttemptId,
            )
          : undefined;
      setOpenedPr(`${pr.owner}/${pr.repo}#${pr.number}`);
      setWorkbench(runId === undefined ? value : { ...value, runId });
      navigate({ kind: "workbench", sessionId: value.session.id });
    } catch {
      setOpenError(`Could not prepare ${pr.owner}/${pr.repo}#${pr.number}.`);
    }
  }
  async function startRun(
    profileId: string,
    sessionId: string,
    attemptId: string,
  ): Promise<string | undefined> {
    try {
      const value = await api("/v1/runs/review-pr", {
        method: "POST",
        body: { profileId, sessionId, attemptId },
      });
      return record(value) && typeof value.runId === "string"
        ? value.runId
        : undefined;
    } catch {
      return undefined;
    }
  }
  async function startOwnedRun(
    profileId: string,
    sessionId: string,
    attemptId: string,
  ): Promise<void> {
    if (attemptId.length === 0) return;
    const runId = await startRun(profileId, sessionId, attemptId);
    if (runId !== undefined)
      setWorkbench((current) =>
        current === undefined ? current : { ...current, runId },
      );
  }
  async function openStoredSession(record: ReviewRecord): Promise<void> {
    await openStoredSessionById(record.profileId, record.id);
  }
  async function openStoredSessionById(
    profileId: string,
    sessionId: string,
  ): Promise<void> {
    const value = await api("/v1/reviews/load", {
      method: "POST",
      body: { profileId, sessionId },
    });
    if (!isWorkbenchPayload(value)) return;
    setWorkbench(value);
    navigate({ kind: "workbench", sessionId });
  }
  async function reviewWrite(
    path: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ readonly reviewId: string }> {
    if (
      workbench === undefined ||
      dashboard === undefined ||
      workbench.draft === undefined
    )
      throw new Error("Review workbench is unavailable");
    const revision =
      record(workbench.draft) && typeof workbench.draft.updatedAt === "string"
        ? workbench.draft.updatedAt
        : undefined;
    if (revision === undefined)
      throw new Error("The saved draft revision is unavailable");
    const value = await api(path, {
      method: "POST",
      body: {
        profileId: dashboard.profile.id,
        sessionId: workbench.session.id,
        expectedRevision: revision,
        acknowledgement: true,
        ...extra,
      },
    });
    if (!isWorkbenchWrite(value)) throw new Error("Review write was rejected");
    setWorkbench((current) =>
      current === undefined
        ? current
        : {
            ...current,
            session: value.session as WorkbenchPayload["session"],
            draft: value.draft,
          },
    );
    const state = value.draft.state as {
      readonly pendingReviewId?: string;
      readonly reviewId?: string;
    };
    return { reviewId: state.reviewId ?? state.pendingReviewId ?? "review" };
  }
  async function saveDraft(input: {
    readonly expectedRevision: string;
    readonly summaryBody: string;
    readonly comments: ReadonlyArray<{
      readonly findingId: string;
      readonly include: boolean;
      readonly body: string;
    }>;
  }): Promise<{ readonly draft: never; readonly revision: string }> {
    if (workbench === undefined || dashboard === undefined)
      throw new Error("Review workbench is unavailable");
    const value = await api("/v1/reviews/draft", {
      method: "POST",
      body: {
        profileId: dashboard.profile.id,
        sessionId: workbench.session.id,
        ...input,
      },
    });
    if (
      !record(value) ||
      !record(value.session) ||
      !record(value.draft) ||
      typeof value.revision !== "string"
    )
      throw new Error("Draft save was rejected");
    setWorkbench((current) =>
      current === undefined
        ? current
        : {
            ...current,
            session: value.session as WorkbenchPayload["session"],
            draft: value.draft,
          },
    );
    return { draft: value.draft as never, revision: value.revision };
  }
  async function mergeReview(
    method: "merge" | "squash" | "rebase",
    acknowledgedWarnings: boolean,
  ): Promise<{ readonly mergeCommitSha?: string }> {
    if (workbench === undefined || dashboard === undefined)
      throw new Error("Review workbench is unavailable");
    const value = await api("/v1/reviews/merge", {
      method: "POST",
      body: {
        profileId: dashboard.profile.id,
        sessionId: workbench.session.id,
        method,
        acknowledgedWarnings,
      },
    });
    if (!record(value) || !record(value.session))
      throw new Error("Merge was rejected");
    setWorkbench((current) =>
      current === undefined
        ? current
        : { ...current, session: value.session as WorkbenchPayload["session"] },
    );
    const mergeCommitSha =
      record(value.session.mergeDecision) &&
      typeof value.session.mergeDecision.mergeCommitSha === "string"
        ? value.session.mergeDecision.mergeCommitSha
        : undefined;
    return mergeCommitSha === undefined ? {} : { mergeCommitSha };
  }

  return shell(
    <div className={destination.kind === "dashboard" || destination.kind === "workbench" ? "flex min-h-0 flex-1 flex-col" : "p-3 min-[1280px]:p-4"}>
      {destination.kind === "dashboard" || destination.kind === "workbench" ? (
        inbox !== undefined && dashboard !== undefined ? (
          <InboxScreen
            state={state}
            inbox={inbox}
            dashboard={dashboard}
            reference={reference}
            onReference={setReference}
            onPreview={() => void previewEntry()}
            onRefresh={() => void refreshDashboard()}
            onSettings={() => navigate({ kind: "settings" })}
            onOpenReview={(row, mode) =>
              void openPullRequest(
                row.identity,
                mode,
                row.recommendedAction.kind === "review_updates"
                  ? row.recommendedAction.baseSessionId
                  : undefined,
              )
            }
            onOpenSession={(sessionId) =>
              void openStoredSessionById(dashboard.profile.id, sessionId)
            }
            {...(openedPr === undefined ? {} : { openedPr })}
            {...(openError === undefined ? {} : { openError })}
          />
        ) : (
        <Pending
          state={state}
          {...(dashboard === undefined ? {} : { dashboard })}
          {...(inbox === undefined ? {} : { inbox })}
          reference={reference}
          onReference={setReference}
          onPreview={() => void previewEntry()}
          onRefresh={() => void refreshDashboard()}
          onSettings={() => navigate({ kind: "settings" })}
          onOpenRow={(pr) => void openPullRequest(pr)}
          {...(openedPr === undefined ? {} : { openedPr })}
          {...(openError === undefined ? {} : { openError })}
        />
        )
      ) : destination.kind === "settings" ? (
        <Settings
          {...(dashboard === undefined ? {} : { dashboard })}
          paths={paths}
          setPaths={setPaths}
          newRepo={newRepo}
          setNewRepo={setNewRepo}
          profileDraft={profileDraft}
          setProfileDraft={setProfileDraft}
          suggestions={suggestions}
          profiles={profiles}
          {...(githubAccess === undefined ? {} : { githubAccess })}
          {...(environment === undefined ? {} : { environment })}
          {...(pathFeedback === undefined ? {} : { pathFeedback })}
          onAdd={() => void addRepo()}
          onSaveProfile={() => void saveProfile()}
          onDiscover={() => void discover()}
          onAddSuggestion={(repo) => void addSuggestion(repo)}
          onTestGitHubAccess={() => void testGitHubAccess()}
          onCheckEnvironment={() => void checkEnvironment()}
          onSelectProfile={(id) => void select(id)}
          onPath={editPath}
          onChoosePath={(repo) => void choosePath(repo)}
          onRemove={remove}
          onArchive={archive}
          onRefreshRepo={refreshRepo}
        />
      ) : (
        <ReviewRecords
          records={reviewRecords}
          state={reviewRecordsState}
          invalidCount={invalidReviewRecordCount}
          draftsOnly={destination.kind === "drafts"}
          onRetry={() => {
            if (dashboard !== undefined)
              void loadReviewRecords(dashboard.profile.id);
          }}
          onOpen={(record) => void openStoredSession(record)}
        />
      )}
      <Dialog
        open={preview?.confirmation.required === true}
        onOpenChange={(open) => {
          if (!open) setPreview(undefined);
        }}
      >
        {preview === undefined ? null : (
          <DialogContent
            initialFocus={keepProfileButton}
            finalFocus={previewTrigger}
          >
            <DialogHeader>
              <DialogTitle>Switch workspace profile</DialogTitle>
              <DialogDescription>
                Use the suggested profile before opening {preview.pr.owner}/
                {preview.pr.repo}#{preview.pr.number}.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                ref={keepProfileButton}
                variant="outline"
                onClick={() => setPreview(undefined)}
              >
                Keep current profile
              </Button>
              <Button onClick={() => void confirmEntry()}>
                Switch profile and open pull request
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>,
  );
}

function RunFixturePanel(): React.JSX.Element {
  const [runId, setRunId] = useState<string>();
  return (
    <SafeRunPanel
      profileId="fixture"
      sessionId="fixture-session"
      attemptId="001"
      {...(runId === undefined ? {} : { runId })}
      onStart={async () => {
        const value = await requestJson("/v1/runs/review-pr", {
          method: "POST",
          body: {
            profileId: "fixture",
            sessionId: "fixture-session",
            attemptId: "001",
          },
        });
        if (record(value) && typeof value.runId === "string")
          setRunId(value.runId);
      }}
    />
  );
}

const fixturePatch = buildFixturePatch();

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

function buildLargePatchFixture(): string {
  const files: Array<string> = [];
  const oldLine = `-${"old-value-".padEnd(79, "x")}`;
  const newLine = `+${"new-value-".padEnd(79, "y")}`;
  for (let index = 0; index < 1_000; index += 1) {
    const number = String(index).padStart(4, "0");
    const path = `src/generated/file-${number}.ts`;
    const changes: Array<string> = [];
    for (let line = 0; line < 64; line += 1) changes.push(oldLine, newLine);
    files.push(
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,64 +1,64 @@\n${changes.join("\n")}\n`,
    );
  }
  return files.join("");
}

const workbenchFixtureData = {
  fullPatch: fixturePatch,
  pullRequest: {
    ref: {
      host: "github.com",
      owner: "centraldigital",
      repo: "patchdesk",
      number: 42,
    },
    title: "Protect review writes",
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
      "The head SHA remains current while this local draft is edited.",
    ],
  },
  draft: {
    summaryBody:
      "One mapped finding and one finding that needs manual placement.",
    comments: [
      {
        findingId: "mapped",
        body: "Keep the stale-head check at the write boundary.",
        postability: "postable" as const,
      },
    ],
  },
  editableDraft: {
    sessionId: "fixture-session",
    attemptId: "001",
    state: { _tag: "LocalDraft" },
    summaryBody:
      "One mapped finding and one finding that needs manual placement.",
    suggestedEvent: "COMMENT",
    comments: [
      {
        findingId: "mapped",
        include: true,
        originalSuggestedBody:
          "Keep the stale-head check at the write boundary.",
        body: "Keep the stale-head check at the write boundary.",
        path: "src/b.ts",
        line: 1,
        diffSide: "new",
        postability: "postable",
      },
    ],
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
  },
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
            createdAt: "2026-07-16T00:00:00.000Z" as never,
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
  history: [
    { id: "001", state: "ReviewCompleted" as const },
    { id: "002", state: "ReviewFailed" as const },
    { id: "003", state: "Stale" as const },
    { id: "004", state: "Discarded" as const },
    { id: "005", state: "Merged" as const },
    { id: "006", state: "IgnoredLateResult" as const },
  ],
  debugHref: "/debug/fixture-session",
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

const submissionFixtureData = {
  draft: {
    state: { _tag: "LocalDraft" },
    summaryBody: "Request changes before merge.",
    comments: [
      {
        findingId: "p1",
        include: true,
        path: "src/services/review-submission-service.ts",
        line: 34,
        body: "Keep the stale-head check at the write boundary.",
        postability: "postable",
      },
      {
        findingId: "unmapped",
        include: true,
        path: "src/services/review-submission-service.ts",
        line: 55,
        body: "This has no verified GitHub location.",
        postability: "invalid_line",
      },
    ],
  },
  findings: [{ id: "p1", severity: "P1" }],
};

function InboxScreen({
  state,
  inbox,
  dashboard,
  reference,
  onReference,
  onPreview,
  onRefresh,
  onSettings,
  onOpenReview,
  onOpenSession,
  openedPr,
  openError,
}: {
  readonly state: DashboardScreenState;
  readonly inbox: InboxResponse;
  readonly dashboard: Dashboard;
  readonly reference: string;
  readonly onReference: (value: string) => void;
  readonly onPreview: () => void;
  readonly onRefresh: () => void;
  readonly onSettings: () => void;
  readonly onOpenReview: (
    row: InboxResponse["inbox"]["rows"][number],
    mode: ReviewStartMode,
  ) => void;
  readonly onOpenSession: (sessionId: string) => void;
  readonly openedPr?: string;
  readonly openError?: string;
}): React.JSX.Element {
  return (
    <div className="flex min-h-full min-w-0 flex-col">
      {openedPr === undefined ? null : (
        <Alert className="mx-4 mt-4">
          <AlertTitle>Review opened</AlertTitle>
          <AlertDescription>{openedPr}</AlertDescription>
        </Alert>
      )}
      {openError === undefined ? null : (
        <Alert variant="destructive" className="mx-4 mt-4">
          <AlertTitle>Could not open review</AlertTitle>
          <AlertDescription>{openError}</AlertDescription>
        </Alert>
      )}
      <div className="border-b bg-muted/10 px-4 py-2">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <Label className="sr-only" htmlFor="pr-reference">
              Pull request reference
            </Label>
            <Input
              id="pr-reference"
              className="h-8 text-xs"
              placeholder="owner/repository#123"
              value={reference}
              onChange={(event) => onReference(event.target.value)}
            />
          </div>
          <Button size="sm" className="text-xs" onClick={onPreview} disabled={state === "loading"}>
            Preview pull request
          </Button>
        </div>
      </div>
      <Outcome
        state={state}
        repos={dashboard.dashboard.repos}
        onRetry={onRefresh}
        onSettings={onSettings}
      />
      <div className="min-h-0 flex-1">
        <MaintainerInbox
          profileId={inbox.profile.id}
          profileLabel={inbox.profile.label}
          rows={inbox.inbox.rows}
          freshness={inbox.inbox.dataFreshness}
          loading={state === "loading"}
          onRefresh={onRefresh}
          onOpenReview={onOpenReview}
          onOpenSession={onOpenSession}
        />
      </div>
    </div>
  );
}

function Pending({
  state,
  dashboard,
  inbox,
  reference,
  onReference,
  onPreview,
  onRefresh,
  onSettings,
  onOpenRow,
  openedPr,
  openError,
}: {
  readonly state: DashboardScreenState;
  readonly dashboard?: Dashboard;
  readonly inbox?: InboxResponse;
  readonly reference: string;
  readonly onReference: (value: string) => void;
  readonly onPreview: () => void;
  readonly onRefresh: () => void;
  readonly onSettings: () => void;
  readonly onOpenRow: (pr: Preview["pr"]) => void;
  readonly openedPr?: string;
  readonly openError?: string;
}): React.JSX.Element {
  const [selected, setSelected] = useState<PrRow | undefined>();
  const [launchOpen, setLaunchOpen] = useState(false);
  return (
    <div className="mx-auto max-w-[112rem]">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">
            {dashboard?.profile.label ?? "First run"}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Maintainer inbox
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Review requests, updates since your last review, checks, and local
            draft state across the active watchlist.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={onRefresh}
          disabled={state === "loading"}
        >
          Refresh
        </Button>
      </header>
      {openedPr ? (
        <Alert className="mt-4">
          <AlertTitle>Review opened</AlertTitle>
          <AlertDescription>{openedPr}</AlertDescription>
        </Alert>
      ) : null}
      {openError ? (
        <Alert variant="destructive" className="mt-4">
          <AlertTitle>Could not open review</AlertTitle>
          <AlertDescription>{openError}</AlertDescription>
        </Alert>
      ) : null}
      {inbox?.inbox.dataFreshness === "cached" ? (
        <Alert className="mt-4">
          <AlertTitle>Cached inbox data</AlertTitle>
          <AlertDescription>
            GitHub could not be refreshed. Merge-oriented actions stay disabled
            until current data is available.
          </AlertDescription>
        </Alert>
      ) : null}
      <Card className="mt-6 gap-4 py-4">
        <CardContent className="flex flex-wrap items-end gap-3 px-4">
          <div className="min-w-[15rem] flex-1">
            <Label htmlFor="pr-reference">Pull request reference</Label>
            <Input
              id="pr-reference"
              className="mt-1.5"
              placeholder="owner/repository#123 or GitHub URL"
              value={reference}
              onChange={(event) => onReference(event.target.value)}
            />
          </div>
          <Button onClick={onPreview} disabled={dashboard === undefined}>
            Preview pull request
          </Button>
        </CardContent>
      </Card>
      <Outcome
        state={state}
        repos={dashboard?.dashboard.repos ?? []}
        onRetry={onRefresh}
        onSettings={onSettings}
      />
      <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="min-w-0 gap-0 py-0">
          <Table>
            <TableCaption className="sr-only">
              Pending pull requests in the active watchlist
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Pull request</TableHead>
                <TableHead>Repository</TableHead>
                <TableHead>Author</TableHead>
                <TableHead>Checks</TableHead>
                <TableHead>Priority</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dashboard?.dashboard.rows.map((row) => (
                <TableRow
                  key={`${row.summary.ref.owner}/${row.summary.ref.repo}#${row.summary.ref.number}`}
                  data-state={selected === row ? "selected" : undefined}
                  className="cursor-pointer"
                  onClick={() => setSelected(row)}
                >
                  <TableCell>
                    <Button
                      variant="link"
                      className="h-auto min-h-6 justify-start p-0 text-left"
                      onClick={() => setSelected(row)}
                    >
                      #{row.summary.ref.number} {row.summary.title}
                    </Button>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.summary.ref.owner}/{row.summary.ref.repo}
                  </TableCell>
                  <TableCell>{row.summary.author}</TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {row.summary.checkSummary?.overall ?? "unknown"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {row.badges[0] ?? row.priority}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
        <Card className="h-fit gap-4 py-5">
          <CardHeader className="px-5">
            <CardTitle>Review inspector</CardTitle>
            <CardDescription>
              Select a pull request to verify its exact identity before launch.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-5">
            {selected === undefined ? (
              <p className="text-sm text-muted-foreground">
                No pull request selected.
              </p>
            ) : (
              <div className="space-y-3 text-sm">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Pull request
                  </p>
                  <p className="mt-1 font-medium">
                    {selected.summary.ref.owner}/{selected.summary.ref.repo}#
                    {selected.summary.ref.number}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Title
                  </p>
                  <p className="mt-1">{selected.summary.title}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {selected.badges.map((badge) => (
                    <Badge key={badge} variant="secondary">
                      {badge}
                    </Badge>
                  ))}
                </div>
                <Button className="w-full" onClick={() => setLaunchOpen(true)}>
                  Run review
                </Button>
                <p className="text-xs text-muted-foreground">
                  Read-only analysis starts locally. GitHub writes remain
                  separately confirmed.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      <Dialog open={launchOpen} onOpenChange={setLaunchOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run local review</DialogTitle>
            <DialogDescription>
              Confirm the exact pull request. This starts read-only analysis and
              does not write to GitHub.
            </DialogDescription>
          </DialogHeader>
          {selected === undefined ? null : (
            <div className="rounded-lg border bg-muted p-4 text-sm">
              <p className="font-medium">
                {selected.summary.ref.owner}/{selected.summary.ref.repo}#
                {selected.summary.ref.number}
              </p>
              <p className="mt-1 text-muted-foreground">
                {selected.summary.title}
              </p>
              <p className="mt-3">Profile: {dashboard?.profile.label}</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setLaunchOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (selected !== undefined) onOpenRow(selected.summary.ref);
                setLaunchOpen(false);
              }}
            >
              Start review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
function Outcome({
  state,
  repos,
  onRetry,
  onSettings,
}: {
  readonly state: DashboardScreenState;
  readonly repos: ReadonlyArray<RepoOutcome>;
  readonly onRetry: () => void;
  readonly onSettings: () => void;
}): React.JSX.Element {
  if (state === "loading")
    return (
      <div className="mt-6 space-y-2" aria-label="Loading dashboard">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-3/4" />
      </div>
    );
  if (state === "empty")
    return (
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>
            <h2>Set up Patchdesk</h2>
          </CardTitle>
          <CardDescription>
            Complete these local checks once, then Patchdesk can load pending
            pull requests.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3 text-sm">
            <li>
              <span className="font-medium">1. Confirm GitHub access</span>
              <p className="text-muted-foreground">
                Choose the GitHub account Patchdesk should use for read-only
                discovery.
              </p>
            </li>
            <li>
              <span className="font-medium">2. Check local tools</span>
              <p className="text-muted-foreground">
                Verify Git, GitHub CLI, and the bundled review runtime without
                exposing credentials.
              </p>
            </li>
            <li>
              <span className="font-medium">3. Add your first repository</span>
              <p className="text-muted-foreground">
                Select a local checkout so reviews can use repository context.
              </p>
            </li>
          </ol>
          <Button className="mt-5" onClick={onSettings}>
            Open Settings to finish setup
          </Button>
        </CardContent>
      </Card>
    );
  if (state === "error" && repos.length === 0)
    return (
      <Alert variant="destructive" className="mt-6">
        <AlertTitle>Dashboard could not be loaded</AlertTitle>
        <AlertDescription>
          Patchdesk could not read the active profile or GitHub dashboard. Local
          drafts and history remain on this Mac.
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" onClick={onRetry}>
              Retry dashboard
            </Button>
            <Button variant="outline" onClick={onSettings}>
              Open Settings
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  if (state === "degraded")
    return (
      <Alert className="mt-6">
        <AlertTitle>Some repositories need attention</AlertTitle>
        <AlertDescription>
          A local checkout path is missing, so repository-aware review is
          blocked only for those repositories. Healthy repositories remain
          available.
          <div>
            <Button className="mt-3" variant="outline" onClick={onSettings}>
              Open Settings to choose a local path
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  return (
    <section className="mt-6 space-y-2">
      {repos
        .filter((repo) => repo.state !== "ready")
        .map(({ repo, state: outcome }) => (
          <Alert
            key={key(repo)}
            variant={
              outcome === "github_auth" || outcome === "github_read"
                ? "destructive"
                : "default"
            }
          >
            <AlertTitle>
              {repo.owner}/{repo.repo}
            </AlertTitle>
            <AlertDescription>
              {outcome === "no_open_prs"
                ? "No pending pull requests were found. Refresh when you expect new work."
                : outcome === "github_auth"
                  ? "GitHub authentication is required before Patchdesk can refresh pull requests. Local drafts and history remain available."
                  : outcome === "github_read"
                    ? "GitHub metadata is temporarily unavailable. Retry the read; Patchdesk will not discard local review data."
                    : outcome === "archived"
                      ? "Archived repository. It is hidden from the active queue and can be restored in Settings."
                      : outcome === "missing_local_path"
                        ? "Choose a local checkout path before running a repository-aware review."
                        : outcome}
              {outcome === "github_read" ? (
                <div>
                  <Button className="mt-3" variant="outline" onClick={onRetry}>
                    Retry GitHub read
                  </Button>
                </div>
              ) : outcome === "github_auth" ? (
                <div>
                  <Button
                    className="mt-3"
                    variant="outline"
                    onClick={onSettings}
                  >
                    Open Settings for GitHub access
                  </Button>
                </div>
              ) : outcome === "missing_local_path" || outcome === "archived" ? (
                <div>
                  <Button
                    className="mt-3"
                    variant="outline"
                    onClick={onSettings}
                  >
                    Open repository Settings
                  </Button>
                </div>
              ) : null}
            </AlertDescription>
          </Alert>
        ))}
    </section>
  );
}
function ReviewRecords({
  records,
  state,
  invalidCount,
  draftsOnly,
  onRetry,
  onOpen,
}: {
  readonly records: ReadonlyArray<ReviewRecord>;
  readonly state: "idle" | "loading" | "ready" | "error";
  readonly invalidCount: number;
  readonly draftsOnly: boolean;
  readonly onRetry: () => void;
  readonly onOpen: (record: ReviewRecord) => void;
}): React.JSX.Element {
  const visible = draftsOnly
    ? records.filter(
        (record) =>
          record.draftState !== undefined &&
          record.draftState !== "SubmittedGitHubReview",
      )
    : records;
  return (
    <div className="mx-auto max-w-5xl">
      <header>
        <p className="text-xs font-medium uppercase tracking-[.14em] text-primary">
          Local review records
        </p>
        <h1 className="mt-2 text-2xl font-semibold">
          {draftsOnly ? "Review drafts" : "Review history"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Saved sessions are reopened from durable local state; opening one
          never restarts its workflow.
        </p>
      </header>
      <div className="mt-6 space-y-3">
        {state === "loading" || state === "idle" ? (
          <Card role="status" aria-label="Loading local review records">
            <CardContent className="space-y-3 py-6">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-9 w-full" />
            </CardContent>
          </Card>
        ) : state === "error" ? (
          <Alert variant="destructive">
            <AlertTitle>Local review records could not be loaded</AlertTitle>
            <AlertDescription className="mt-2">
              Your saved data remains on this Mac. Retry the local read without
              starting a review.
              <div>
                <Button className="mt-3" variant="outline" onClick={onRetry}>
                  Retry loading local review records
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {invalidCount === 0 ? null : (
              <Alert>
                <AlertTitle>Some local records were skipped</AlertTitle>
                <AlertDescription>
                  {invalidCount} local review{" "}
                  {invalidCount === 1 ? "record" : "records"} could not be read.
                  Healthy records remain available.
                </AlertDescription>
              </Alert>
            )}
            {visible.length === 0 ? (
              <Card>
                <CardContent className="py-6 text-sm text-muted-foreground">
                  No matching local review records.
                </CardContent>
              </Card>
            ) : (
              visible.map((record) => (
                <Card key={record.id} className="gap-3 py-4">
                  <CardContent className="flex flex-wrap items-center justify-between gap-4 px-4">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{record.state}</Badge>
                        {record.draftState === undefined ? null : (
                          <Badge variant="secondary">{record.draftState}</Badge>
                        )}
                      </div>
                      <h2 className="mt-2 font-semibold">
                        {record.owner}/{record.repo}#{record.prNumber} ·{" "}
                        {record.title ?? "Stored pull request"}
                      </h2>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Updated {record.updatedAt}
                      </p>
                    </div>
                    <Button variant="outline" onClick={() => onOpen(record)}>
                      Open saved review
                    </Button>
                  </CardContent>
                </Card>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Settings({
  dashboard,
  paths,
  setPaths,
  newRepo,
  setNewRepo,
  profileDraft,
  setProfileDraft,
  suggestions,
  profiles,
  githubAccess,
  environment,
  pathFeedback,
  onAdd,
  onSaveProfile,
  onDiscover,
  onAddSuggestion,
  onTestGitHubAccess,
  onCheckEnvironment,
  onSelectProfile,
  onPath,
  onChoosePath,
  onRemove,
  onArchive,
  onRefreshRepo,
}: {
  readonly dashboard?: Dashboard;
  readonly paths: Record<string, string>;
  readonly setPaths: React.Dispatch<
    React.SetStateAction<Record<string, string>>
  >;
  readonly newRepo: string;
  readonly setNewRepo: (value: string) => void;
  readonly profileDraft: {
    readonly id: string;
    readonly label: string;
    readonly githubHost: string;
    readonly ghAccount: string;
    readonly workspaceRoot: string;
  };
  readonly setProfileDraft: React.Dispatch<
    React.SetStateAction<{
      id: string;
      label: string;
      githubHost: string;
      ghAccount: string;
      workspaceRoot: string;
    }>
  >;
  readonly suggestions: ReadonlyArray<Repo>;
  readonly profiles: ReadonlyArray<Profile>;
  readonly githubAccess?: string;
  readonly environment?: Record<string, string>;
  readonly pathFeedback?: string;
  readonly onAdd: () => void;
  readonly onSaveProfile: () => void;
  readonly onDiscover: () => void;
  readonly onAddSuggestion: (repo: Repo) => void;
  readonly onTestGitHubAccess: () => void;
  readonly onCheckEnvironment: () => void;
  readonly onSelectProfile: (id: string) => void;
  readonly onPath: (repo: Repo) => void;
  readonly onChoosePath: (repo: Repo) => void;
  readonly onRemove: (repo: Repo) => Promise<void>;
  readonly onArchive: (repo: Repo) => void;
  readonly onRefreshRepo: (repo: Repo) => void;
}): React.JSX.Element {
  const [removalTarget, setRemovalTarget] = useState<Repo>();
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string>();
  const setupSteps =
    environment === undefined ? [] : environmentSetupSteps(environment);

  const confirmRemoval = async (): Promise<void> => {
    if (removalTarget === undefined || removing) return;
    setRemoving(true);
    setRemoveError(undefined);
    try {
      await onRemove(removalTarget);
      setRemovalTarget(undefined);
    } catch (cause: unknown) {
      setRemoveError(
        cause instanceof Error
          ? cause.message
          : "Patchdesk could not remove this repository.",
      );
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Workspace profiles, repository paths, and safe environment
          diagnostics.
        </p>
      </header>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Workspace profile</CardTitle>
            <CardDescription>
              GitHub reads and local paths are scoped to the selected profile.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="active-profile">Active profile</Label>
              <Select
                value={dashboard?.profile.id ?? profileDraft.id}
                onValueChange={(value) => {
                  if (value !== null) onSelectProfile(value);
                }}
              >
                <SelectTrigger id="active-profile" className="mt-1.5">
                  <SelectValue placeholder="Select a profile" />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {(
              [
                ["Profile ID", "id"],
                ["Label", "label"],
                ["GitHub host", "githubHost"],
                ["GitHub account", "ghAccount"],
                ["Workspace root", "workspaceRoot"],
              ] as const
            ).map(([label, field]) => (
              <div key={field}>
                <Label htmlFor={`profile-${field}`}>{label}</Label>
                <Input
                  id={`profile-${field}`}
                  className="mt-1.5"
                  value={profileDraft[field]}
                  placeholder={
                    field === "workspaceRoot"
                      ? "/absolute/workspace/path"
                      : undefined
                  }
                  onChange={(event) =>
                    setProfileDraft((current) => ({
                      ...current,
                      [field]: event.target.value,
                    }))
                  }
                />
              </div>
            ))}
            <Button onClick={onSaveProfile}>Save profile</Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Environment diagnostics</CardTitle>
            <CardDescription>
              Readiness only; Patchdesk never displays token values or command
              output.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={onCheckEnvironment}>
                {setupSteps.length === 0
                  ? "Check environment"
                  : "Recheck environment"}
              </Button>
              <Button variant="outline" onClick={onTestGitHubAccess}>
                Test GitHub access
              </Button>
            </div>
            {githubAccess === undefined ? null : (
              <p className="mt-4 text-sm">
                GitHub access: <Badge variant="outline">{githubAccess}</Badge>
              </p>
            )}
            {environment === undefined ? (
              <p className="mt-4 text-sm text-muted-foreground">
                Loading safe environment diagnostics.
              </p>
            ) : (
              <>
                <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
                  {Object.entries(environment)
                    .filter(
                      ([name]) =>
                        ![
                          "productName",
                          "version",
                          "architecture",
                          "distribution",
                        ].includes(name),
                    )
                    .map(([name, value]) => (
                      <div key={name} className="rounded-md border p-2">
                        <dt className="text-muted-foreground">{name}</dt>
                        <dd className="mt-1 font-medium">
                          {value.replaceAll("_", " ")}
                        </dd>
                      </div>
                    ))}
                </dl>
                {setupSteps.length === 0 ? null : (
                  <Alert variant="destructive" className="mt-4">
                    <AlertTitle>Setup action required</AlertTitle>
                    <AlertDescription>
                      <ul className="list-disc space-y-1 pl-5">
                        {setupSteps.map((step) => (
                          <li key={step}>{step}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>About Patchdesk</h2>
            </CardTitle>
            <CardDescription>
              Build identity for diagnostics and internal distribution.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {environment === undefined ? (
              <p className="text-muted-foreground">
                Loading build information.
              </p>
            ) : (
              <>
                <p className="font-medium">
                  Version {environment.version ?? "unknown"}
                </p>
                <p>
                  <span className="text-muted-foreground">Architecture </span>
                  {environment.architecture ?? "unknown"}
                </p>
                <Badge variant="outline">
                  {environment.distribution === "unsigned_internal"
                    ? "Unsigned internal build"
                    : "Development build"}
                </Badge>
                <p className="text-muted-foreground">
                  Signing, notarization, and external distribution are outside
                  this internal build.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Watchlist</CardTitle>
          <CardDescription>
            Archive hides a repository from the active queue and is reversible.
            Remove deletes only the watchlist entry; saved review history and
            drafts remain local.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-60 flex-1">
              <Label htmlFor="repo-add">Repository</Label>
              <Input
                id="repo-add"
                className="mt-1.5"
                value={newRepo}
                onChange={(event) => setNewRepo(event.target.value)}
                placeholder="owner/repo"
              />
            </div>
            <Button onClick={onAdd}>Add repository</Button>
            <Button variant="outline" onClick={onDiscover}>
              Discover workspace repositories
            </Button>
          </div>
          {suggestions.length === 0 ? null : (
            <div className="mt-4 space-y-2">
              {suggestions.map((repo) => (
                <div
                  key={key(repo)}
                  className="flex items-center justify-between rounded-md border p-3 text-sm"
                >
                  <span>
                    {repo.owner}/{repo.repo}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onAddSuggestion(repo)}
                  >
                    Add suggestion
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      {pathFeedback === undefined ? null : (
        <p
          role="status"
          aria-live="polite"
          className="text-sm text-muted-foreground"
        >
          {pathFeedback}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {dashboard?.dashboard.repos.map(({ repo }) => (
          <Card key={key(repo)} className="gap-4 py-5">
            <CardHeader className="px-5">
              <CardTitle>
                {repo.owner}/{repo.repo}
              </CardTitle>
              <CardDescription>
                {repo.archived ? "Archived repository" : "Active repository"}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-5">
              <Label htmlFor={`path-${key(repo)}`}>
                Local path for {repo.owner}/{repo.repo}
              </Label>
              <div className="mt-1.5 flex gap-2">
                <Input
                  id={`path-${key(repo)}`}
                  value={paths[key(repo)] ?? repo.localPath ?? ""}
                  onChange={(event) =>
                    setPaths((current) => ({
                      ...current,
                      [key(repo)]: event.target.value,
                    }))
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onChoosePath(repo)}
                  aria-label={`Choose folder for ${repo.owner}/${repo.repo}`}
                >
                  Choose folder
                </Button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => onPath(repo)}
                  aria-label={`Save path for ${repo.owner}/${repo.repo}`}
                >
                  Save path
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onRefreshRepo(repo)}
                  aria-label={`Refresh ${repo.owner}/${repo.repo}`}
                >
                  Refresh
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onArchive(repo)}
                  aria-label={`${repo.archived ? "Restore" : "Archive"} ${repo.owner}/${repo.repo}`}
                >
                  {repo.archived ? "Restore" : "Archive"}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  aria-label={`Remove ${repo.owner}/${repo.repo}`}
                  onClick={() => {
                    setRemoveError(undefined);
                    setRemovalTarget(repo);
                  }}
                >
                  Remove
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <AlertDialog
        open={removalTarget !== undefined}
        onOpenChange={(open) => {
          if (!open && !removing) {
            setRemovalTarget(undefined);
            setRemoveError(undefined);
          }
        }}
      >
        <AlertDialogContent aria-busy={removing}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removalTarget?.owner}/{removalTarget?.repo} from the
              watchlist?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Saved review history and drafts remain on this Mac.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="text-sm text-muted-foreground">
            Remove deletes the watchlist entry. Choose Archive instead when you
            only want to hide this repository from the active queue.
          </p>
          {removeError === undefined ? null : (
            <Alert variant="destructive">
              <AlertTitle>Repository was not removed</AlertTitle>
              <AlertDescription>{removeError}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={removing}
              onClick={() => {
                void confirmRemoval();
              }}
            >
              {removing ? "Removing…" : "Confirm removal"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
function environmentSetupSteps(
  environment: Readonly<Record<string, string>>,
): ReadonlyArray<string> {
  const steps: Array<string> = [];
  if (environment.git !== "ready" || environment.gh !== "ready")
    steps.push(
      "Git and GitHub CLI must be available to Patchdesk from a Dock-launched environment.",
    );
  if (environment.githubAuth !== "ready")
    steps.push(
      "Authenticate the configured GitHub CLI account, then test GitHub access again.",
    );
  if (environment.runtime !== "ready" && environment.runtime !== "bundled")
    steps.push(
      "Install or repair the bundled review runtime before starting a review.",
    );
  if (
    environment.modelConfiguration !== "ready" &&
    environment.modelConfiguration !== "configured"
  )
    steps.push(
      "Configure a model provider before running a review; local history remains readable without it.",
    );
  return steps;
}
async function api(
  path: string,
  init: { readonly method?: string; readonly body?: unknown } = {},
): Promise<unknown> {
  return await requestJson(path, {
    ...(init.method === undefined
      ? {}
      : { method: init.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE" }),
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}
function key(repo: Repo): string {
  return `${repo.host}/${repo.owner}/${repo.repo}`;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function isProfile(value: unknown): value is Profile {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    typeof value.githubHost === "string" &&
    typeof value.ghAccount === "string"
  );
}
function isRepo(value: unknown): value is Repo {
  return (
    record(value) &&
    typeof value.host === "string" &&
    typeof value.owner === "string" &&
    typeof value.repo === "string"
  );
}
function isReviewRecord(value: unknown): value is ReviewRecord {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.profileId === "string" &&
    typeof value.owner === "string" &&
    typeof value.repo === "string" &&
    typeof value.prNumber === "number" &&
    typeof value.state === "string" &&
    typeof value.updatedAt === "string"
  );
}
function isDashboard(value: unknown): value is Dashboard {
  return (
    record(value) &&
    isProfile(value.profile) &&
    record(value.dashboard) &&
    Array.isArray(value.dashboard.rows) &&
    Array.isArray(value.dashboard.repos)
  );
}

function dashboardFromInbox(inbox: InboxResponse): Dashboard {
  return {
    profile: {
      id: inbox.profile.id,
      label: inbox.profile.label,
      githubHost: inbox.profile.githubHost,
      ghAccount: inbox.profile.ghAccount,
      ...(inbox.profile.workspaceRoots === undefined
        ? {}
        : { workspaceRoots: inbox.profile.workspaceRoots }),
    },
    dashboard: {
      rows: inbox.inbox.rows.map((row) => ({
        summary: {
          ref: row.identity,
          title: row.title,
          author: row.author,
          checkSummary: row.checks,
        },
        priority: row.categories[0] ?? "review",
        badges: row.categories,
      })),
      repos: inbox.inbox.repositories.map((outcome) => ({
        repo: {
          host: outcome.repo.host,
          owner: outcome.repo.owner,
          repo: outcome.repo.repo,
          ...(outcome.repo.archived === undefined
            ? {}
            : { archived: outcome.repo.archived }),
        },
        state: outcome.state,
      })),
    },
  };
}
function isWorkbenchPayload(value: unknown): value is WorkbenchPayload {
  // Completed v1 sessions are still legitimate local history. Keep the
  // renderer boundary strict for new rich projections, but permit the
  // pre-Phase-2 shape while the main process normalizes it on reopen.
  return (
    parseWorkbenchResponse(value) !== undefined ||
    (record(value) &&
      typeof value.state === "string" &&
      record(value.session) &&
      typeof value.session.id === "string")
  );
}
function isWorkbenchWrite(value: unknown): value is {
  readonly session: unknown;
  readonly draft: { readonly state: unknown };
} {
  return (
    record(value) &&
    "session" in value &&
    record(value.draft) &&
    "state" in value.draft
  );
}
function isPreview(value: unknown): value is Preview {
  return (
    record(value) &&
    record(value.pr) &&
    typeof value.pr.owner === "string" &&
    typeof value.pr.repo === "string" &&
    typeof value.pr.number === "number" &&
    record(value.confirmation) &&
    typeof value.confirmation.required === "boolean"
  );
}
