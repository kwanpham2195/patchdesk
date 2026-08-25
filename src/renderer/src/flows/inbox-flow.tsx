import { CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  MaintainerInbox,
  type ReviewInitialSection,
} from "../components/maintainer-inbox";
import { MaintainerInboxSkeleton } from "../components/maintainer-inbox-skeleton";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Skeleton } from "../components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { PatchdeskApiError, requestJson } from "../api-client";
import { useBusy } from "../hooks/use-busy";
import {
  parseEnvironmentCheckResponse,
  parseGitHubAccessCheckResponse,
  parseWorkbenchResponse,
} from "../renderer-contracts";
import type { inboxFreshnessLabel } from "../inbox-refresh-scheduler";
import type { SettingsSection } from "./settings-flow";
import type {
  Dashboard,
  DashboardScreenState,
  PrRow,
  RepoOutcome,
  WorkbenchPayload,
} from "../renderer-models";
import type {
  EnvironmentCheckResponse,
  InboxResponse,
} from "../renderer-contracts";

export function InboxFlow({
  destination,
  reviewId,
  dashboard,
  inbox,
  state,
  refreshStatus,
  onRefresh,
  scope = "open",
  hasPreviousPage = false,
  hasNextPage = false,
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
  readonly refreshStatus: ReturnType<typeof inboxFreshnessLabel>;
  readonly onRefresh: () => void;
  /** Confirmed remote scope; Phase 1 only permits open pull requests. */
  readonly scope?: "open";
  readonly hasPreviousPage?: boolean;
  readonly hasNextPage?: boolean;
  readonly onPreviousInboxPage?: () => void;
  readonly onNextInboxPage?: () => void;
  readonly onSettings: (section?: SettingsSection) => void;
  readonly onOpenWorkbench: (
    workbench: WorkbenchPayload,
    initialSection?: ReviewInitialSection,
  ) => void;
}): React.JSX.Element {
  const [openedPr, setOpenedPr] = useState<string>();
  const [openError, setOpenError] = useState<string>();
  const dashboardProfileId = dashboard?.profile.id;
  const { runBusy } = useBusy();

  type PrRef = {
    readonly host?: string;
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  };

  const openPullRequest = useCallback(
    async (
      pr: PrRef,
      initialSection?: ReviewInitialSection,
      profileId = dashboard?.profile.id,
    ): Promise<void> => {
      setOpenedPr(undefined);
      setOpenError(undefined);
      await runBusy(async () => {
        try {
          const value = await requestJson("/v1/reviews/open", {
            method: "POST",
            body: {
              profileId,
              host: pr.host ?? dashboard?.profile.githubHost ?? "github.com",
              owner: pr.owner,
              repo: pr.repo,
              number: pr.number,
            },
          });
          const parsed = parseWorkbenchResponse(value);
          if (parsed === undefined)
            throw new Error("Invalid workbench projection");
          setOpenedPr(`${pr.owner}/${pr.repo}#${pr.number}`);
          onOpenWorkbench(parsed, initialSection);
        } catch (cause: unknown) {
          // Mirrors the dashboard's `github_auth` copy above, adapted from
          // refreshing pull requests to opening one: the generic "auth" API
          // message doesn't name the fix, and opening a Review is exactly
          // where a missing profile credential first becomes user-visible.
          const detail =
            cause instanceof PatchdeskApiError && cause.kind === "auth"
              ? "GitHub authentication is required to open this Review. Run gh auth login for the exact GitHub account entered in Settings -> Workspace."
              : cause instanceof Error
                ? cause.message
                : String(cause);
          setOpenError(
            `Could not prepare ${pr.owner}/${pr.repo}#${pr.number}. ${detail}`,
          );
        }
      }, "Opening pull request…");
    },
    [
      dashboard?.profile.githubHost,
      dashboard?.profile.id,
      onOpenWorkbench,
      runBusy,
    ],
  );

  const openStoredReview = useCallback(
    async (
      profileId: string,
      reference: { readonly reviewId: string },
      identity?: PrRef,
      isActive: () => boolean = () => true,
    ): Promise<void> => {
      await runBusy(async () => {
        try {
          const value = await requestJson("/v1/reviews/load", {
            method: "POST",
            body: { profileId, ...reference },
          });
          const parsed = parseWorkbenchResponse(value);
          if (parsed === undefined) {
            if (isActive())
              setOpenError(
                "Could not open the saved review. The review projection could not be validated; refresh the review and try again.",
              );
            return;
          }
          if (!isActive()) return;
          onOpenWorkbench(parsed);
        } catch (cause: unknown) {
          // The stored review cannot be loaded: its record is missing or its
          // snapshot no longer parses. Opening by PR identity heals or recreates
          // it, and returns the same projection for a healthy review.
          if (identity !== undefined) {
            await openPullRequest(identity);
            return;
          }
          const detail = cause instanceof Error ? cause.message : String(cause);
          setOpenError(`Could not open the saved review. ${detail}`);
        }
      }, "Loading review…");
    },
    [onOpenWorkbench, openPullRequest, runBusy],
  );
  const openStoredReviewById = useCallback(
    async (
      profileId: string,
      reviewId: string,
      identity?: PrRef,
      isActive: () => boolean = () => true,
    ): Promise<void> => {
      await openStoredReview(profileId, { reviewId }, identity, isActive);
    },
    [openStoredReview],
  );
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
      undefined,
      () => active,
    );
    return () => {
      active = false;
    };
  }, [dashboardProfileId, destination, openStoredReviewById, reviewId]);

  if (inbox === undefined || dashboard === undefined)
    return state === "loading" ? (
      <MaintainerInboxSkeleton />
    ) : (
      <Pending
        state={state}
        {...(dashboard === undefined ? {} : { dashboard })}
        {...(inbox === undefined ? {} : { inbox })}
        {...(openedPr === undefined ? {} : { openedPr })}
        {...(openError === undefined ? {} : { openError })}
        onOpenRow={(pr) => void openPullRequest(pr)}
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
      {...(openError === undefined ? {} : { openError })}
      onRefresh={onRefresh}
      scope={scope}
      hasPreviousPage={hasPreviousPage}
      hasNextPage={hasNextPage}
      onPreviousInboxPage={onPreviousInboxPage}
      onNextInboxPage={onNextInboxPage}
      onSettings={onSettings}
      onOpenReview={(row, initialSection) =>
        void openPullRequest(row.identity, initialSection)
      }
      onOpenReviewId={(savedReviewId) => {
        const row = inbox.inbox.rows.find(
          (candidate) =>
            candidate.recommendedAction.kind !== "run_review" &&
            candidate.recommendedAction.reviewId === savedReviewId,
        );
        void openStoredReviewById(
          dashboard.profile.id,
          savedReviewId,
          row?.identity,
        );
      }}
    />
  );
}

function InboxScreen({
  state,
  inbox,
  dashboard,
  onRefresh,
  scope,
  hasPreviousPage,
  hasNextPage,
  onPreviousInboxPage,
  onNextInboxPage,
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
  readonly scope: "open";
  readonly hasPreviousPage: boolean;
  readonly hasNextPage: boolean;
  readonly onPreviousInboxPage: () => void;
  readonly onNextInboxPage: () => void;
  readonly refreshStatus: ReturnType<typeof inboxFreshnessLabel>;
  readonly onSettings: (section?: SettingsSection) => void;
  readonly onOpenReview: (
    row: InboxResponse["inbox"]["rows"][number],
    initialSection?: ReviewInitialSection,
  ) => void;
  readonly onOpenReviewId: (reviewId: string) => void;
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
          {...(inbox.profile.repos === undefined
            ? {}
            : { repos: inbox.profile.repos })}
          freshness={inbox.inbox.dataFreshness}
          {...(inbox.inbox.snapshot === undefined
            ? {}
            : { snapshot: inbox.inbox.snapshot })}
          refreshStatus={refreshStatus}
          onRefresh={onRefresh}
          scope={scope}
          page={inbox.inbox.page}
          hasPreviousPage={hasPreviousPage}
          hasNextPage={hasNextPage}
          onPreviousPage={onPreviousInboxPage}
          onNextPage={onNextInboxPage}
          onOpenReview={onOpenReview}
          onOpenReviewId={onOpenReviewId}
        />
      </div>
    </div>
  );
}

function Pending({
  state,
  dashboard,
  inbox,
  onRefresh,
  onSettings,
  onOpenRow,
  openedPr,
  openError,
}: {
  readonly state: DashboardScreenState;
  readonly dashboard?: Dashboard;
  readonly inbox?: InboxResponse;
  readonly onRefresh: () => void;
  readonly onSettings: (section?: SettingsSection) => void;
  readonly onOpenRow: (pr: {
    readonly host?: string;
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  }) => void;
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
      <Outcome
        state={state}
        repos={dashboard?.dashboard.repos ?? []}
        onRetry={onRefresh}
        onSettings={onSettings}
      />
      <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="min-w-0">
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
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Review inspector</CardTitle>
            <CardDescription>
              Select a pull request to verify its exact identity before launch.
            </CardDescription>
          </CardHeader>
          <CardContent>
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
                  Run Analysis
                </Button>
                <p className="text-xs text-muted-foreground">
                  Analysis runs locally as evidence. GitHub writes remain
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
            <DialogTitle>Run Analysis</DialogTitle>
            <DialogDescription>
              Confirm the exact pull request. Analysis produces evidence and
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
              Start Analysis
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
type AccessCheckState =
  | { readonly kind: "checking" }
  | { readonly kind: "available" }
  | { readonly kind: "github_auth" }
  | { readonly kind: "error" };

type ToolsCheckState =
  | { readonly kind: "checking" }
  | { readonly kind: "loaded"; readonly env: EnvironmentCheckResponse }
  | { readonly kind: "error" };

/**
 * Renders the first two setup-checklist items against their real, current
 * state (`POST /v1/github/access`, `GET /v1/environment`) instead of static
 * prose. Both fetch on mount and again whenever "Re-check" is pressed, so a
 * user who fixes something in a terminal (installs `gh`, runs
 * `gh auth login`) can confirm it without restarting the app.
 */
function SetupChecklist(): React.JSX.Element {
  const [access, setAccess] = useState<AccessCheckState>({
    kind: "checking",
  });
  const [tools, setTools] = useState<ToolsCheckState>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setAccess({ kind: "checking" });
    void (async () => {
      try {
        const value = await requestJson("/v1/github/access", {
          method: "POST",
        });
        if (!active) return;
        const parsed = parseGitHubAccessCheckResponse(value);
        setAccess(
          parsed === undefined ? { kind: "error" } : { kind: parsed.state },
        );
      } catch {
        if (active) setAccess({ kind: "error" });
      }
    })();
    return () => {
      active = false;
    };
  }, [attempt]);

  useEffect(() => {
    let active = true;
    setTools({ kind: "checking" });
    void (async () => {
      try {
        const value = await requestJson("/v1/environment");
        if (!active) return;
        const parsed = parseEnvironmentCheckResponse(value);
        setTools(
          parsed === undefined
            ? { kind: "error" }
            : { kind: "loaded", env: parsed },
        );
      } catch {
        if (active) setTools({ kind: "error" });
      }
    })();
    return () => {
      active = false;
    };
  }, [attempt]);

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
  readonly state: AccessCheckState;
}): React.JSX.Element {
  switch (state.kind) {
    case "checking":
      return (
        <StatusLine
          tone="muted"
          icon={<LoaderCircle className="animate-spin" />}
        >
          Checking GitHub access…
        </StatusLine>
      );
    case "available":
      return (
        <StatusLine tone="pass" icon={<CheckCircle2 />}>
          GitHub access confirmed.
        </StatusLine>
      );
    case "github_auth":
      return (
        <StatusLine tone="fail" icon={<CircleAlert />}>
          Not authenticated. Run <code>gh auth login</code> for the GitHub
          account entered in Settings, under Workspace, then re-check.
        </StatusLine>
      );
    case "error":
      return (
        <StatusLine tone="fail" icon={<CircleAlert />}>
          Could not check GitHub access.
        </StatusLine>
      );
  }
}

function ToolsCheckLines({
  state,
}: {
  readonly state: ToolsCheckState;
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
  const { env } = state;
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
  if (state === "degraded")
    return (
      <Alert className="mt-6">
        <AlertTitle>Some repositories need attention</AlertTitle>
        <AlertDescription>
          A local checkout path is missing, so repository-aware review is
          blocked only for those repositories. Healthy repositories remain
          available.
          <div>
            <Button
              className="mt-3"
              variant="outline"
              onClick={() => onSettings()}
            >
              Open Settings to choose a local path
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  return (
    <section className="mt-6 space-y-2">
      {repos.flatMap(({ repo, state: outcome, resumeAt, forbiddenReason }) =>
        outcome === "ready" || outcome === "no_open_prs"
          ? []
          : [
              <Alert
                key={key(repo)}
                variant={
                  outcome === "github_auth" ||
                  outcome === "github_read" ||
                  outcome === "github_forbidden"
                    ? "destructive"
                    : "default"
                }
              >
                <AlertTitle>
                  {repo.owner}/{repo.repo}
                </AlertTitle>
                <AlertDescription>
                  {outcome === "github_auth"
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

function key(repo: {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}): string {
  return `${repo.host}/${repo.owner}/${repo.repo}`;
}

/**
 * Names why GitHub forbade this read and what the maintainer must actually
 * do about it. No retry button is ever offered for a forbidden read: none
 * of these conditions resolve by asking again, and a working retry button
 * would falsely imply one might (see docs/adr/0024-explain-forbidden-github-reads.md).
 */
function forbiddenCopy(
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
function rateLimitedCopy(resumeAt: string | undefined): string {
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
