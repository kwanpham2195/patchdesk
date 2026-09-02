import { CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  MaintainerInbox,
  type InboxLabelActions,
} from "../components/maintainer-inbox";
import { MaintainerInboxSkeleton } from "../components/maintainer-inbox-skeleton";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { requestJson } from "../api-client";
import {
  useApiProbe,
  useEnvironmentCheck,
  type ApiProbeState,
} from "../hooks/use-api-probe";
import {
  parseGitHubAccessCheckResponse,
  parseRepositoryLabelListResponse,
} from "../renderer-contracts";
import type { InboxFreshnessLabel } from "../inbox-freshness";
import {
  DEFAULT_INBOX_PAGE_SIZE,
  type InboxCheckStatusFilter,
  type InboxFilterTextFailure,
  type InboxPageSize,
  type InboxReviewStateFilter,
  type InboxStateFilter,
} from "../../../domain/maintainer-inbox";
import type { SettingsSection } from "./settings-flow";
import type {
  Dashboard,
  DashboardScreenState,
  RepoOutcome,
  WorkbenchPayload,
} from "../renderer-models";
import type {
  EnvironmentCheckResponse,
  GitHubAccessCheckResponse,
  InboxResponse,
  RepositoryLabelListResponse,
} from "../renderer-contracts";
import {
  sameRepositoryIdentity,
  type RepositoryIdentity,
} from "../../../domain/repository-identity";
import { parseGitHubHost } from "../../../domain/ids";
import { parsePullRequestInput } from "../../../domain/pull-request";
import { isTextEntryTarget } from "../text-entry-target";
import { useInboxReviewOpening } from "./use-inbox-review-opening";

export function InboxFlow({
  destination,
  reviewId,
  dashboard,
  inbox,
  state,
  refreshStatus,
  onRefresh,
  inboxState = "open",
  listPending = false,
  pageSize = DEFAULT_INBOX_PAGE_SIZE,
  hasPreviousPage = false,
  hasNextPage = false,
  onInboxStateChange = () => undefined,
  onInboxPageSizeChange = () => undefined,
  selectedLabels = [],
  onInboxLabelsChange = () => undefined,
  awaitingMyReview = false,
  onInboxAwaitingMyReviewChange = () => undefined,
  reviewState,
  onInboxReviewStateChange = () => undefined,
  checkStatus,
  onInboxCheckStatusChange = () => undefined,
  author,
  onInboxAuthorChange = () => undefined,
  baseBranch,
  onInboxBaseBranchChange = () => undefined,
  onClearInboxMoreFilters = () => undefined,
  selectedRepository,
  onRepositoryChange = () => undefined,
  onPreviousInboxPage = () => undefined,
  onNextInboxPage = () => undefined,
  onSettings,
  onOpenWorkbench,
}: {
  readonly destination: "dashboard" | "workbench";
  readonly reviewId?: string;
  readonly dashboard?: Dashboard;
  readonly inbox?: InboxResponse;
  readonly state: DashboardScreenState;
  readonly refreshStatus: InboxFreshnessLabel;
  readonly onRefresh: () => void;
  /** The requested pull-request state filter — named `inboxState` here only
   * because this component already carries a screen-level `state`. Only App
   * owns its request transition; the toggle reflects this immediately, and
   * `listPending` says whether `inbox`'s rows have caught up to it yet. */
  readonly inboxState?: InboxStateFilter;
  /** True while `inbox`'s confirmed state filter has not caught up to the
   * requested one (a change is still in flight). The row list,
   * row count, and details panel must hold a loading state instead of
   * rendering the previous state's rows under the new state's label. */
  readonly listPending?: boolean;
  /** Confirmed remote page size; only App owns its request transition. */
  readonly pageSize?: InboxPageSize;
  readonly hasPreviousPage?: boolean;
  readonly hasNextPage?: boolean;
  readonly onInboxStateChange?: (state: InboxStateFilter) => void;
  readonly onInboxPageSizeChange?: (pageSize: InboxPageSize) => void;
  /** The label filter, sent to GitHub as `label:"NAME"` qualifiers — never a
   * local, in-page filter. Only App owns its request transition. */
  readonly selectedLabels?: ReadonlyArray<string>;
  readonly onInboxLabelsChange?: (labels: ReadonlyArray<string>) => void;
  /** The "Awaiting review from you" preset (ADR 0031), sent to GitHub as
   * `user-review-requested:@me`. Only App owns its request transition. */
  readonly awaitingMyReview?: boolean;
  readonly onInboxAwaitingMyReviewChange?: (value: boolean) => void;
  readonly reviewState?: InboxReviewStateFilter;
  readonly onInboxReviewStateChange?: (
    value: InboxReviewStateFilter | undefined,
  ) => void;
  readonly checkStatus?: InboxCheckStatusFilter;
  readonly onInboxCheckStatusChange?: (
    value: InboxCheckStatusFilter | undefined,
  ) => void;
  readonly author?: string;
  readonly onInboxAuthorChange?: (
    value: string | undefined,
  ) => InboxFilterTextFailure | undefined;
  readonly baseBranch?: string;
  readonly onInboxBaseBranchChange?: (
    value: string | undefined,
  ) => InboxFilterTextFailure | undefined;
  readonly onClearInboxMoreFilters?: () => void;
  /** The screen's root state (ADR 0031); only App owns its request
   * transition. Absent only before the active profile's watchlist is known. */
  readonly selectedRepository?: RepositoryIdentity;
  readonly onRepositoryChange?: (repository: RepositoryIdentity) => void;
  readonly onPreviousInboxPage?: () => void;
  readonly onNextInboxPage?: () => void;
  readonly onSettings: (section?: SettingsSection) => void;
  readonly onOpenWorkbench: (workbench: WorkbenchPayload) => void;
}): React.JSX.Element {
  const {
    openedPr,
    openError,
    openingOperations,
    openInboxRow,
    openPullRequestByRef,
    openStoredReviewById,
    reportOpenError,
  } = useInboxReviewOpening({ dashboard, onOpenWorkbench });
  const fetchInboxLabels = useCallback(async (): Promise<
    RepositoryLabelListResponse | undefined
  > => {
    if (selectedRepository === undefined) return undefined;
    const query = new URLSearchParams({
      host: selectedRepository.host,
      owner: selectedRepository.owner,
      repo: selectedRepository.repo,
    });
    return parseRepositoryLabelListResponse(
      await requestJson(`/v1/inbox/labels?${query.toString()}`),
    );
  }, [selectedRepository]);
  const labelActions: InboxLabelActions | undefined =
    selectedRepository === undefined
      ? undefined
      : { fetchLabels: fetchInboxLabels };
  const dashboardProfileId = dashboard?.profile.id;

  useEffect(() => {
    if (
      destination !== "workbench" ||
      dashboardProfileId === undefined ||
      reviewId === undefined
    )
      return;
    let active = true;
    void openStoredReviewById(dashboardProfileId, reviewId, () => active);
    return () => {
      active = false;
    };
  }, [dashboardProfileId, destination, openStoredReviewById, reviewId]);

  const profileGitHubHost = dashboard?.profile.githubHost;
  const watchedRepos = dashboard?.profile.repos;

  // The Pull requests screen has no address bar, so a pasted pull-request
  // link is caught on the document and opened as if its row had been
  // activated (issue #67).
  useEffect(() => {
    if (destination !== "dashboard" || profileGitHubHost === undefined) return;
    const parsedHost = parseGitHubHost(profileGitHubHost);
    const onPaste = (event: ClipboardEvent): void => {
      // A paste into a field belongs to that field, never to the screen.
      if (isTextEntryTarget(event.target)) return;
      const parsed = parsePullRequestInput(
        event.clipboardData?.getData("text/plain")?.trim(),
        parsedHost._tag === "ok" ? parsedHost.value : undefined,
      );
      // Anything that is not a pull-request reference stays an ordinary paste.
      if (parsed._tag === "err") return;
      event.preventDefault();
      const ref = parsed.value;
      const watched = (watchedRepos ?? []).some((repo) =>
        sameRepositoryIdentity(repo, ref),
      );
      if (!watched) {
        reportOpenError(
          `Not opened: ${ref.owner}/${ref.repo} is not a watched repository.`,
        );
        return;
      }
      openPullRequestByRef(ref);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [
    destination,
    openPullRequestByRef,
    profileGitHubHost,
    reportOpenError,
    watchedRepos,
  ]);

  const rowOpenError = [...openingOperations.values()].find(
    ({ status }) => status === "error",
  )?.error;
  const activeOpenError = openError ?? rowOpenError;

  if (inbox === undefined || dashboard === undefined)
    return state === "loading" ? (
      <MaintainerInboxSkeleton />
    ) : (
      <BootstrapOutcome
        state={state}
        onRefresh={onRefresh}
        onSettings={onSettings}
      />
    );

  return (
    <InboxScreen
      state={state}
      inbox={inbox}
      dashboard={dashboard}
      refreshStatus={refreshStatus}
      {...(openedPr === undefined ? {} : { openedPr })}
      {...(activeOpenError === undefined ? {} : { openError: activeOpenError })}
      onRefresh={onRefresh}
      inboxState={inboxState}
      listPending={listPending}
      pageSize={pageSize}
      hasPreviousPage={hasPreviousPage}
      hasNextPage={hasNextPage}
      onInboxStateChange={onInboxStateChange}
      onInboxPageSizeChange={onInboxPageSizeChange}
      selectedLabels={selectedLabels}
      onInboxLabelsChange={onInboxLabelsChange}
      awaitingMyReview={awaitingMyReview}
      onInboxAwaitingMyReviewChange={onInboxAwaitingMyReviewChange}
      {...(reviewState === undefined ? {} : { reviewState })}
      onInboxReviewStateChange={onInboxReviewStateChange}
      {...(checkStatus === undefined ? {} : { checkStatus })}
      onInboxCheckStatusChange={onInboxCheckStatusChange}
      {...(author === undefined ? {} : { author })}
      onInboxAuthorChange={onInboxAuthorChange}
      {...(baseBranch === undefined ? {} : { baseBranch })}
      onInboxBaseBranchChange={onInboxBaseBranchChange}
      onClearInboxMoreFilters={onClearInboxMoreFilters}
      {...(labelActions === undefined ? {} : { labelActions })}
      {...(selectedRepository === undefined ? {} : { selectedRepository })}
      onRepositoryChange={onRepositoryChange}
      onPreviousInboxPage={onPreviousInboxPage}
      onNextInboxPage={onNextInboxPage}
      openingOperations={openingOperations}
      onSettings={onSettings}
      onOpenReview={openInboxRow}
      onOpenReviewId={(savedReviewId) => {
        const row = inbox.inbox.rows.find(
          (candidate) =>
            candidate.recommendedAction.kind === "open_saved_review" &&
            candidate.recommendedAction.reviewId === savedReviewId,
        );
        if (row !== undefined) openInboxRow(row);
      }}
    />
  );
}

function InboxScreen({
  state,
  inbox,
  dashboard,
  onRefresh,
  inboxState,
  listPending,
  pageSize,
  hasPreviousPage,
  hasNextPage,
  onInboxStateChange,
  onInboxPageSizeChange,
  selectedLabels,
  onInboxLabelsChange,
  awaitingMyReview,
  onInboxAwaitingMyReviewChange,
  reviewState,
  onInboxReviewStateChange,
  checkStatus,
  onInboxCheckStatusChange,
  author,
  onInboxAuthorChange,
  baseBranch,
  onInboxBaseBranchChange,
  onClearInboxMoreFilters,
  labelActions,
  selectedRepository,
  onRepositoryChange,
  onPreviousInboxPage,
  onNextInboxPage,
  openingOperations,
  refreshStatus,
  onSettings,
  onOpenReview,
  onOpenReviewId,
  openedPr,
  openError,
}: {
  readonly state: DashboardScreenState;
  readonly inbox: InboxResponse;
  readonly dashboard: Dashboard;
  readonly onRefresh: () => void;
  /** The requested pull-request state filter; see `InboxFlow`'s `inboxState`
   * for why it is not simply `state` here. */
  readonly inboxState: InboxStateFilter;
  readonly listPending: boolean;
  readonly pageSize: InboxPageSize;
  readonly hasPreviousPage: boolean;
  readonly hasNextPage: boolean;
  readonly onInboxStateChange: (state: InboxStateFilter) => void;
  readonly onInboxPageSizeChange: (pageSize: InboxPageSize) => void;
  readonly selectedLabels: ReadonlyArray<string>;
  readonly onInboxLabelsChange: (labels: ReadonlyArray<string>) => void;
  readonly awaitingMyReview: boolean;
  readonly onInboxAwaitingMyReviewChange: (value: boolean) => void;
  readonly reviewState?: InboxReviewStateFilter;
  readonly onInboxReviewStateChange: (
    value: InboxReviewStateFilter | undefined,
  ) => void;
  readonly checkStatus?: InboxCheckStatusFilter;
  readonly onInboxCheckStatusChange: (
    value: InboxCheckStatusFilter | undefined,
  ) => void;
  readonly author?: string;
  readonly onInboxAuthorChange: (
    value: string | undefined,
  ) => InboxFilterTextFailure | undefined;
  readonly baseBranch?: string;
  readonly onInboxBaseBranchChange: (
    value: string | undefined,
  ) => InboxFilterTextFailure | undefined;
  readonly onClearInboxMoreFilters: () => void;
  readonly labelActions?: InboxLabelActions;
  readonly selectedRepository?: RepositoryIdentity;
  readonly onRepositoryChange: (repository: RepositoryIdentity) => void;
  readonly onPreviousInboxPage: () => void;
  readonly onNextInboxPage: () => void;
  readonly openingOperations: ReadonlyMap<
    string,
    { readonly status: "opening" | "error"; readonly error?: string }
  >;
  readonly refreshStatus: InboxFreshnessLabel;
  readonly onSettings: (section?: SettingsSection) => void;
  readonly onOpenReview: (row: InboxResponse["inbox"]["rows"][number]) => void;
  readonly onOpenReviewId: (reviewId: string) => void;
  readonly openedPr?: string;
  readonly openError?: string;
}): React.JSX.Element {
  return (
    <div className="flex min-h-full min-w-0 flex-col">
      {openedPr === undefined ? null : (
        <Alert variant="success" className="mx-4 mt-4">
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
      <Outcome
        state={state}
        repos={dashboard.dashboard.repos}
        onRetry={onRefresh}
        onSettings={onSettings}
      />
      <div className="min-h-0 flex-1">
        <MaintainerInbox
          // Remounts the view on a repository change so the label filter and
          // every other locally-owned view state reload fresh from
          // preferences (already cleared by `onRepositoryChange`) instead of
          // carrying labels scoped to the previous repository.
          key={
            selectedRepository === undefined ? "none" : key(selectedRepository)
          }
          profileId={inbox.profile.id}
          profileLabel={inbox.profile.label}
          rows={inbox.inbox.rows}
          {...(inbox.profile.repos === undefined
            ? {}
            : { repos: inbox.profile.repos })}
          {...(selectedRepository === undefined ? {} : { selectedRepository })}
          onRepositoryChange={onRepositoryChange}
          freshness={inbox.inbox.dataFreshness}
          {...(inbox.inbox.snapshot === undefined
            ? {}
            : { snapshot: inbox.inbox.snapshot })}
          refreshStatus={refreshStatus}
          state={inboxState}
          listPending={listPending}
          onRefresh={onRefresh}
          selectedLabels={selectedLabels}
          onLabelsChange={onInboxLabelsChange}
          awaitingMyReview={awaitingMyReview}
          onAwaitingMyReviewChange={onInboxAwaitingMyReviewChange}
          {...(reviewState === undefined ? {} : { reviewState })}
          onReviewStateChange={onInboxReviewStateChange}
          {...(checkStatus === undefined ? {} : { checkStatus })}
          onCheckStatusChange={onInboxCheckStatusChange}
          {...(author === undefined ? {} : { author })}
          onAuthorChange={onInboxAuthorChange}
          {...(baseBranch === undefined ? {} : { baseBranch })}
          onBaseBranchChange={onInboxBaseBranchChange}
          onClearInboxMoreFilters={onClearInboxMoreFilters}
          {...(labelActions === undefined ? {} : { labelActions })}
          {...(inbox.inbox.matchCount === undefined
            ? {}
            : { matchCount: inbox.inbox.matchCount })}
          pageSize={pageSize}
          hasPreviousPage={hasPreviousPage}
          hasNextPage={hasNextPage}
          onStateChange={onInboxStateChange}
          onPageSizeChange={onInboxPageSizeChange}
          onPreviousPage={onPreviousInboxPage}
          onNextPage={onNextInboxPage}
          openingOperations={openingOperations}
          onOpenReview={onOpenReview}
          onOpenReviewId={onOpenReviewId}
        />
      </div>
    </div>
  );
}

/**
 * Renders before the first inbox load has ever succeeded: the bootstrap
 * failure ("no local API", the initial fetch throwing, or an unparsable
 * response) and the first-run empty state. `dashboard` and `inbox` are
 * always undefined here — `workspaceReducer`'s `loaded`/`refreshSucceeded`/
 * `cleared` actions only ever set both together, so the gate that reaches
 * this branch (`inbox === undefined || dashboard === undefined`, guarded
 * against `state === "loading"`) can only be true when both are undefined.
 */
function BootstrapOutcome({
  state,
  onRefresh,
  onSettings,
}: {
  readonly state: DashboardScreenState;
  readonly onRefresh: () => void;
  readonly onSettings: (section?: SettingsSection) => void;
}): React.JSX.Element {
  return (
    <div className="mx-auto max-w-[112rem]">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">First run</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Pull requests
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Review requests, review freshness, checks, and current Review state
            across the active watchlist.
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
      <Outcome
        state={state}
        repos={[]}
        onRetry={onRefresh}
        onSettings={onSettings}
      />
    </div>
  );
}
/**
 * Renders the first two setup-checklist items against their real, current
 * state (`POST /v1/github/access`, `GET /v1/environment`) instead of static
 * prose. Both fetch on mount and again whenever "Re-check" is pressed, so a
 * user who fixes something in a terminal (installs `gh`, runs
 * `gh auth login`) can confirm it without restarting the app.
 */
function SetupChecklist(): React.JSX.Element {
  const [attempt, setAttempt] = useState(0);
  // Two independent requests behind one Re-check button. The environment
  // probe is the same one the Reviewing-as panel in Settings runs, but the
  // two never share a result: the copy below points at Settings, which that
  // panel cannot.
  const access = useApiProbe(
    { path: "/v1/github/access", method: "POST", restartKey: attempt },
    parseGitHubAccessCheckResponse,
  );
  const tools = useEnvironmentCheck(attempt);

  return (
    <>
      <ol className="space-y-3 text-sm">
        <li>
          <span className="font-medium">1. Confirm GitHub access</span>
          <p className="text-muted-foreground">
            Choose the GitHub account Patchdesk should use for read-only
            discovery.
          </p>
          <AccessCheckLine state={access} />
        </li>
        <li>
          <span className="font-medium">2. Check local tools</span>
          <p className="text-muted-foreground">
            Verify Git and GitHub access without exposing credentials.
          </p>
          <ToolsCheckLines state={tools} />
        </li>
        <li>
          <span className="font-medium">3. Add your first repository</span>
          <p className="text-muted-foreground">
            Select a local checkout so reviews can use repository context.
          </p>
        </li>
      </ol>
      <Button
        variant="outline"
        size="sm"
        className="mt-4"
        onClick={() => setAttempt((value) => value + 1)}
      >
        Re-check
      </Button>
    </>
  );
}

function AccessCheckLine({
  state,
}: {
  readonly state: ApiProbeState<GitHubAccessCheckResponse>;
}): React.JSX.Element {
  if (state.kind === "checking")
    return (
      <StatusLine tone="muted" icon={<LoaderCircle className="animate-spin" />}>
        Checking GitHub access…
      </StatusLine>
    );
  if (state.kind === "error")
    return (
      <StatusLine tone="fail" icon={<CircleAlert />}>
        Could not check GitHub access.
      </StatusLine>
    );
  if (state.value.state === "available")
    return (
      <StatusLine tone="pass" icon={<CheckCircle2 />}>
        GitHub access confirmed.
      </StatusLine>
    );
  return (
    <StatusLine tone="fail" icon={<CircleAlert />}>
      Not authenticated. Run <code>gh auth login</code> for the GitHub account
      entered in Settings, under Workspace, then re-check.
    </StatusLine>
  );
}

function ToolsCheckLines({
  state,
}: {
  readonly state: ApiProbeState<EnvironmentCheckResponse>;
}): React.JSX.Element {
  if (state.kind === "checking")
    return (
      <StatusLine tone="muted" icon={<LoaderCircle className="animate-spin" />}>
        Checking git and gh…
      </StatusLine>
    );
  if (state.kind === "error")
    return (
      <StatusLine tone="fail" icon={<CircleAlert />}>
        Could not check local tools.
      </StatusLine>
    );
  const env = state.value;
  return (
    <div className="mt-1 space-y-1">
      {env.git === "ready" ? (
        <StatusLine tone="pass" icon={<CheckCircle2 />}>
          Git is installed.
        </StatusLine>
      ) : (
        <StatusLine tone="fail" icon={<CircleAlert />}>
          Git is not installed. Install Git for this platform, then re-check.
        </StatusLine>
      )}
      {env.gh === "ready" ? (
        <StatusLine tone="pass" icon={<CheckCircle2 />}>
          GitHub CLI (gh) is installed.
        </StatusLine>
      ) : (
        <StatusLine tone="fail" icon={<CircleAlert />}>
          GitHub CLI (gh) is not installed. Install the GitHub CLI, then
          re-check.
        </StatusLine>
      )}
      {env.gh !== "ready" ? null : env.githubAuth === "ready" ? (
        <StatusLine tone="pass" icon={<CheckCircle2 />}>
          GitHub CLI is authenticated.
        </StatusLine>
      ) : env.githubAuth === "authentication_required" ? (
        <StatusLine tone="fail" icon={<CircleAlert />}>
          Not authenticated. Run <code>gh auth login</code> for the GitHub
          account entered in Settings, under Workspace, then re-check.
        </StatusLine>
      ) : (
        <StatusLine tone="fail" icon={<CircleAlert />}>
          GitHub CLI authentication status could not be determined.
        </StatusLine>
      )}
    </div>
  );
}

function StatusLine({
  tone,
  icon,
  children,
}: {
  readonly tone: "muted" | "pass" | "fail";
  readonly icon: React.ReactNode;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const toneClass =
    tone === "pass"
      ? "text-emerald-700 dark:text-emerald-400"
      : tone === "fail"
        ? "text-rose-700 dark:text-rose-400"
        : "text-muted-foreground";
  return (
    <p className={`mt-1 flex items-center gap-1.5 text-xs ${toneClass}`}>
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center [&>svg]:size-3.5">
        {icon}
      </span>
      {children}
    </p>
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
  readonly onSettings: (section?: SettingsSection) => void;
}): React.JSX.Element | null {
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
          <SetupChecklist />
          <Button className="mt-5" onClick={() => onSettings("workspace")}>
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
            <Button variant="outline" onClick={() => onSettings()}>
              Open Settings
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  if (repos.every(({ state: outcome }) => outcome === "ready")) return null;
  return (
    <section className="mt-6 space-y-2">
      {repos.flatMap(({ repo, state: outcome, resumeAt, forbiddenReason }) =>
        outcome === "ready"
          ? []
          : [
              <Alert
                key={key(repo)}
                variant={
                  outcome === "github_auth" ||
                  outcome === "github_read" ||
                  outcome === "github_forbidden"
                    ? "destructive"
                    : outcome === "github_rate_limited"
                      ? "warning"
                      : "info"
                }
              >
                <AlertTitle>
                  {repo.owner}/{repo.repo}
                </AlertTitle>
                <AlertDescription>
                  {outcome === "no_open_prs"
                    ? // Distinct from a filter that excludes everything: this
                      // repository genuinely has nothing matching the current
                      // state and label filter right now — see ADR 0031.
                      "This repository has no pull requests matching the current filter."
                    : outcome === "github_auth"
                      ? "GitHub authentication is required before Patchdesk can refresh pull requests. Run gh auth login for the exact GitHub account entered in Settings -> Workspace. Local review records remain available."
                      : outcome === "github_read"
                        ? "GitHub metadata is temporarily unavailable. Retry the read; Patchdesk will not discard local review data."
                        : outcome === "github_forbidden"
                          ? forbiddenCopy(forbiddenReason, repo)
                          : outcome === "github_rate_limited"
                            ? rateLimitedCopy(resumeAt)
                            : outcome}
                  {outcome === "github_read" ? (
                    <div>
                      <Button
                        className="mt-3"
                        variant="outline"
                        onClick={onRetry}
                      >
                        Retry GitHub read
                      </Button>
                    </div>
                  ) : outcome === "github_auth" ? (
                    <div>
                      <Button
                        className="mt-3"
                        variant="outline"
                        onClick={() => onSettings("workspace")}
                      >
                        Open Settings for GitHub access
                      </Button>
                    </div>
                  ) : null}
                </AlertDescription>
              </Alert>,
            ],
      )}
    </section>
  );
}

function key(repo: RepositoryIdentity): string {
  return `${repo.host}/${repo.owner}/${repo.repo}`;
}

/**
 * Names why GitHub forbade this read and what the maintainer must actually
 * do about it. No retry button is ever offered for a forbidden read: none
 * of these conditions resolve by asking again, and a working retry button
 * would falsely imply one might (see docs/adr/0024-explain-forbidden-github-reads.md).
 */
// oxlint-disable-next-line react/only-export-components -- Shared copy rule, tested as a function in tests/renderer/inbox-read-failure-copy.test.ts.
export function forbiddenCopy(
  reason: string | undefined,
  repo: { readonly owner: string; readonly repo: string },
): string {
  switch (reason) {
    case "ip_allow_list":
      return `GitHub blocked this read: the ${repo.owner} organization has an IP allow list enabled and this network is not on it. Get this machine's IP allow-listed for ${repo.owner}, or connect from a network that already is. Patchdesk will pick it up automatically once access is restored.`;
    case "saml":
      return `GitHub blocked this read: ${repo.owner} requires SAML single sign-on authorization for this account's token. Sign in to ${repo.owner} on github.com and authorize this token for SSO. Patchdesk will pick it up automatically once access is restored.`;
    case "insufficient_scopes":
      return `GitHub blocked this read: this account's token does not have the scopes ${repo.owner} requires. Update the token's scopes on GitHub and reconnect. Patchdesk will pick it up automatically once access is restored.`;
    default:
      return `GitHub blocked this read for ${repo.owner}/${repo.repo} and did not say why. This is not necessarily temporary — check the repository's or organization's access settings on GitHub.`;
  }
}

/**
 * Names the rate limit explicitly and states when it lifts. No retry action is
 * offered here: GitHub's primary rate-limit window is hours long, so an
 * immediate retry would only make it worse; Patchdesk resumes on its own.
 */
// oxlint-disable-next-line react/only-export-components -- Shared copy rule, tested as a function in tests/renderer/inbox-read-failure-copy.test.ts.
export function rateLimitedCopy(resumeAt: string | undefined): string {
  const resumeAtMs = resumeAt === undefined ? Number.NaN : Date.parse(resumeAt);
  if (Number.isNaN(resumeAtMs)) {
    return "GitHub rate-limited this account. Patchdesk will resume automatically once the limit clears.";
  }
  const formatted = new Date(resumeAtMs).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `GitHub rate-limited this account. Patchdesk will resume automatically at ${formatted}.`;
}
