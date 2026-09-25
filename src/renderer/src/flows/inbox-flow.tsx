import { CircleAlert, CircleCheck, X } from "lucide-react";
import { useCallback, useEffect } from "react";
import {
  MaintainerInbox,
  type InboxLabelActions,
} from "../components/maintainer-inbox";
import { MaintainerInboxSkeleton } from "../components/maintainer-inbox-skeleton";
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
  type InboxPreset,
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
import {
  sameRepositoryIdentity,
  type RepositoryIdentity,
} from "../../../domain/repository-identity";
import { OpenLocalReviewAction } from "../components/local-review-source-dialog";
import { WorkspaceFirstRun } from "./inbox-first-run";
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
  labelFits = () => true,
  preset,
  onInboxPresetChange = () => undefined,
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
  /** Whether a label may still be selected under the search-query budget; only App owns it. */
  readonly labelFits?: (name: string) => boolean;
  /** The one-click preset (ADR 0031), sent to GitHub as its own qualifier.
   * Only App owns its request transition. */
  readonly preset?: InboxPreset;
  readonly onInboxPresetChange?: (value: InboxPreset | undefined) => void;
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

  const localRepository = dashboard.profile.repos?.find(
    (repo) =>
      (repo.localPath ?? "") !== "" &&
      sameRepositoryIdentity(repo, selectedRepository),
  );
  const localReviewAction =
    localRepository === undefined ? undefined : (
      <OpenLocalReviewAction
        repositoryLabel={`${localRepository.owner}/${localRepository.repo}`}
        onOpen={(source) =>
          reviewOpening.openLocalReview(localRepository, source)
        }
      />
    );

  return (
    <InboxScreen
      state={state}
      inbox={inbox}
      dashboard={dashboard}
      localReviewAction={localReviewAction}
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
      labelFits={labelFits}
      {...(preset === undefined ? {} : { preset })}
      onInboxPresetChange={onInboxPresetChange}
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
  labelFits,
  preset,
  onInboxPresetChange,
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
  onDismissOpenedPr,
  onDismissOpenError,
  onOpenReview,
  onOpenReviewId,
  openedPr,
  openError,
  localReviewAction,
}: {
  readonly localReviewAction: React.ReactNode;
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
  readonly labelFits: (name: string) => boolean;
  readonly preset?: InboxPreset;
  readonly onInboxPresetChange: (value: InboxPreset | undefined) => void;
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
  readonly onDismissOpenedPr: () => void;
  readonly onDismissOpenError: () => void;
  readonly onOpenReview: (row: InboxResponse["inbox"]["rows"][number]) => void;
  readonly onOpenReviewId: (reviewId: string) => void;
  readonly openedPr?: string;
  readonly openError?: string;
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
          labelFits={labelFits}
          {...(preset === undefined ? {} : { preset })}
          onPresetChange={onInboxPresetChange}
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
          localReviewAction={localReviewAction}
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
                      ? "GitHub sign-in required. Run gh auth login for the account in Settings → Workspace."
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
      return `${repo.owner} has an IP allow list and this network is not on it. Allow-list this machine or switch networks.`;
    case "saml":
      return `${repo.owner} requires SAML SSO for this token. Authorize it on github.com.`;
    case "insufficient_scopes":
      return `This token lacks the scopes ${repo.owner} requires. Update its scopes and reconnect.`;
    default:
      return `GitHub blocked this read for ${repo.owner}/${repo.repo} and gave no reason. Check its access settings.`;
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
