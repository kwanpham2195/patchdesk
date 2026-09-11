import { CircleAlert, CircleCheck, X } from "lucide-react";
import { useCallback, useEffect } from "react";
import {
  MaintainerInbox,
  type InboxLabelActions,
} from "../components/maintainer-inbox";
import { MaintainerInboxSkeleton } from "../components/maintainer-inbox-skeleton";
import type { InspectorInsightRequests } from "../components/review-details-inspector";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { requestJson } from "../api-client";
import { parseRepositoryLabelListResponse } from "../renderer-contracts";
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
} from "../renderer-models";
import type {
  InboxResponse,
  RepositoryLabelListResponse,
} from "../renderer-contracts";
import type { RepositoryIdentity } from "../../../domain/repository-identity";
import { WorkspaceFirstRun } from "./inbox-first-run";
import { useInboxInsightRequests } from "./use-inbox-insight-requests";
import type { InboxReviewOpeningControls } from "./use-inbox-review-opening";

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
  onWorkspaceReload = async () => undefined,
  onBootRestoreMissing,
  reviewOpening,
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
  /** Re-reads profiles and the inbox after the first-run flow persists
   * something. Defaults to a no-op for the callers that never reach the
   * empty state, in the same way every other optional callback here does. */
  readonly onWorkspaceReload?: () => Promise<void>;
  /** Leaves the workbench route when the Review restored at boot is gone.
   * Supplied only while `destination` is that restored one, so a Review the
   * maintainer opened in this session still reports its failure. */
  readonly onBootRestoreMissing?: () => void;
  readonly reviewOpening: InboxReviewOpeningControls;
}): React.JSX.Element {
  const {
    openedPr,
    openError,
    openingOperations,
    openInboxRow,
    openStoredReviewById,
    dismissOpenedPr,
    dismissOpenError,
  } = reviewOpening;
  // A completed run re-reads the listing through the screen's one refresh
  // path, so the inspector's chip and the row's tag update together.
  const { insightRequests, insightRequestAvailability, requestInsight } =
    useInboxInsightRequests({ dashboard, onRowRefresh: onRefresh });
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
    void openStoredReviewById(
      dashboardProfileId,
      reviewId,
      () => active,
      onBootRestoreMissing,
    );
    return () => {
      active = false;
    };
  }, [
    dashboardProfileId,
    destination,
    onBootRestoreMissing,
    openStoredReviewById,
    reviewId,
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
        onWorkspaceReload={onWorkspaceReload}
      />
    );

  // First run replaces the screen rather than sitting above it: a filter
  // toolbar, an empty table and a "select a pull request" inspector are all
  // noise for a workspace that has nothing to list yet, and read as a second
  // thing to do. Lifted here rather than into `Outcome`, which the bootstrap
  // path shares and which renders inside the inbox chrome, not instead of it.
  if (state === "empty" && (dashboard.profile.repos?.length ?? 0) === 0)
    return (
      <div className="mx-auto max-w-[112rem]">
        <WorkspaceFirstRun
          dashboard={dashboard}
          onWorkspaceReload={onWorkspaceReload}
        />
      </div>
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
      insightRequests={{
        requests: insightRequests,
        availability: insightRequestAvailability,
        onRequest: requestInsight,
      }}
      onSettings={onSettings}
      onDismissOpenedPr={dismissOpenedPr}
      onDismissOpenError={dismissOpenError}
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
  insightRequests,
  refreshStatus,
  onSettings,
  onDismissOpenedPr,
  onDismissOpenError,
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
  readonly insightRequests: InspectorInsightRequests;
  readonly refreshStatus: InboxFreshnessLabel;
  readonly onSettings: (section?: SettingsSection) => void;
  readonly onDismissOpenedPr: () => void;
  readonly onDismissOpenError: () => void;
  readonly onOpenReview: (row: InboxResponse["inbox"]["rows"][number]) => void;
  readonly onOpenReviewId: (reviewId: string) => void;
  readonly openedPr?: string;
  readonly openError?: string;
}): React.JSX.Element {
  return (
    <div className="flex min-h-full min-w-0 flex-col">
      {openedPr === undefined ? null : (
        <ReviewOpeningNotice
          tone="success"
          title="Review opened"
          description={openedPr}
          onDismiss={onDismissOpenedPr}
        />
      )}
      {openError === undefined ? null : (
        <ReviewOpeningNotice
          tone="error"
          title="Could not open review"
          description={openError}
          onDismiss={onDismissOpenError}
        />
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
          insightRequests={insightRequests}
          onOpenReview={onOpenReview}
          onOpenReviewId={onOpenReviewId}
        />
      </div>
    </div>
  );
}

/**
 * The outcome of an opening attempt, as one centred card over the listing
 * rather than a full-width strip that reads as the screen's header.
 */
function ReviewOpeningNotice({
  tone,
  title,
  description,
  onDismiss,
}: {
  readonly tone: "success" | "error";
  readonly title: string;
  readonly description: string;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div className="mx-auto mt-4 w-full max-w-xl px-4">
      <Alert variant={tone === "success" ? "success" : "destructive"}>
        {tone === "success" ? <CircleCheck /> : <CircleAlert />}
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{description}</AlertDescription>
        <AlertAction>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            <X />
          </Button>
        </AlertAction>
      </Alert>
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
  onWorkspaceReload,
}: {
  readonly state: DashboardScreenState;
  readonly onRefresh: () => void;
  readonly onSettings: (section?: SettingsSection) => void;
  readonly onWorkspaceReload: () => Promise<void>;
}): React.JSX.Element {
  // First run is the same standalone flow the loaded path renders: the
  // "Pull requests" header and its Refresh button describe a listing this
  // screen has nothing to show yet, and read as a second thing to do.
  if (state === "empty")
    return (
      <div className="mx-auto max-w-[112rem]">
        <WorkspaceFirstRun
          dashboard={undefined}
          onWorkspaceReload={onWorkspaceReload}
        />
      </div>
    );
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
        repos={EMPTY_REPO_OUTCOMES}
        onRetry={onRefresh}
        onSettings={onSettings}
      />
    </div>
  );
}

const EMPTY_REPO_OUTCOMES: ReadonlyArray<RepoOutcome> = [];
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
  // First run is handled by the callers, which render it instead of the
  // screen. What is left here is a workspace that already watches something
  // and has no rows for the current filter, which the listing itself says.
  if (state === "empty") return null;
  if (state === "error" && repos.length === 0)
    return (
      <Alert variant="destructive" className="mt-6">
        <AlertTitle>Dashboard could not be loaded</AlertTitle>
        <AlertDescription>
          Patchdesk could not read the active workspace or GitHub dashboard.
          Local drafts and history remain on this Mac.
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
