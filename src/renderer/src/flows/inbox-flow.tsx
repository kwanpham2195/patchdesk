import { useEffect, useRef, useState } from "react";
import {
  MaintainerInbox,
  type ReviewInitialSection,
  type ReviewStartMode,
} from "../components/maintainer-inbox";
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
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
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
import { requestJson } from "../api-client";
import { parseWorkbenchResponse } from "../renderer-contracts";
import type { inboxFreshnessLabel } from "../inbox-refresh-scheduler";
import type {
  Dashboard,
  DashboardScreenState,
  Preview,
  PrRow,
  RepoOutcome,
  WorkbenchPayload,
} from "../renderer-models";
import type { InboxResponse } from "../renderer-contracts";

export function InboxFlow({
  destination,
  reviewId,
  dashboard,
  inbox,
  state,
  refreshStatus,
  onRefresh,
  onSettings,
  onWorkspaceReload,
  onOpenWorkbench,
}: {
  readonly destination: "dashboard" | "workbench";
  readonly reviewId?: string;
  readonly dashboard?: Dashboard;
  readonly inbox?: InboxResponse;
  readonly state: DashboardScreenState;
  readonly refreshStatus: ReturnType<typeof inboxFreshnessLabel>;
  readonly onRefresh: () => void;
  readonly onSettings: () => void;
  readonly onWorkspaceReload: () => Promise<void>;
  readonly onOpenWorkbench: (
    workbench: WorkbenchPayload,
    initialSection?: ReviewInitialSection,
  ) => void;
}): React.JSX.Element {
  const [reference, setReference] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const [openedPr, setOpenedPr] = useState<string>();
  const [openError, setOpenError] = useState<string>();
  const previewTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (destination !== "workbench" || dashboard === undefined || reviewId === undefined) return;
    let active = true;
    void openStoredReviewById(dashboard.profile.id, reviewId, () => active);
    return () => { active = false; };
  }, [dashboard?.profile.id, destination, reviewId]);

  const openPullRequest = async (
    pr: Preview["pr"],
    mode: ReviewStartMode = "full",
    initialSection?: ReviewInitialSection,
    baseSessionId?: string,
    profileId = dashboard?.profile.id,
  ): Promise<void> => {
    setOpenedPr(undefined);
    setOpenError(undefined);
    try {
      const value = await requestJson("/v1/reviews/open", {
        method: "POST",
        body: {
          profileId,
          host: pr.host ?? dashboard?.profile.githubHost ?? "github.com",
          owner: pr.owner,
          repo: pr.repo,
          number: pr.number,
          mode,
          ...(baseSessionId === undefined ? {} : { baseSessionId }),
        },
      });
      const parsed = parseWorkbenchResponse(value);
      if (parsed === undefined) throw new Error("Invalid workbench projection");
      setOpenedPr(`${pr.owner}/${pr.repo}#${pr.number}`);
      onOpenWorkbench(parsed as unknown as WorkbenchPayload, initialSection);
    } catch {
      setOpenError(`Could not prepare ${pr.owner}/${pr.repo}#${pr.number}.`);
    }
  };

  const previewEntry = async (): Promise<void> => {
    previewTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try {
      const value = await requestJson("/v1/direct-entry/preview", {
        method: "POST",
        body: { reference },
      });
      if (!isPreview(value)) return;
      if (value.confirmation.required) setPreview(value);
      else await openPullRequest(value.pr);
    } catch {
      setOpenError("Could not preview that pull request.");
    }
  };

  const confirmEntry = async (): Promise<void> => {
    if (preview === undefined) return;
    const targetProfileId = preview.confirmation.targetProfileId;
    if (targetProfileId !== undefined) {
      try {
        await requestJson("/v1/profiles/select", { method: "POST", body: { id: targetProfileId } });
        await onWorkspaceReload();
      } catch {
        setOpenError("Could not switch workspace profile.");
        return;
      }
    }
    await openPullRequest(preview.pr, "full", undefined, undefined, targetProfileId);
    setPreview(undefined);
  };

  async function openStoredReviewById(profileId: string, reviewId: string, isActive: () => boolean = () => true): Promise<void> {
    await openStoredReview(profileId, { reviewId }, isActive);
  }

  async function openStoredReviewBySessionId(profileId: string, sessionId: string): Promise<void> {
    await openStoredReview(profileId, { sessionId });
  }

  async function openStoredReview(profileId: string, reference: { readonly reviewId: string } | { readonly sessionId: string }, isActive: () => boolean = () => true): Promise<void> {
    try {
      const value = await requestJson("/v1/reviews/load", { method: "POST", body: { profileId, ...reference } });
      const parsed = parseWorkbenchResponse(value);
      if (parsed === undefined || !isActive()) return;
      onOpenWorkbench(parsed as unknown as WorkbenchPayload);
    } catch {
      setOpenError("Could not open the saved review.");
    }
  }

  const referenceProps = {
    reference,
    onReference: setReference,
    onPreview: () => void previewEntry(),
    onRefresh,
    onSettings,
  };
  const content = inbox !== undefined && dashboard !== undefined ? (
    <InboxScreen
      state={state}
      inbox={inbox}
      dashboard={dashboard}
      refreshStatus={refreshStatus}
      {...referenceProps}
      {...(openedPr === undefined ? {} : { openedPr })}
      {...(openError === undefined ? {} : { openError })}
      onOpenReview={(row, mode, initialSection) => void openPullRequest(row.identity, mode, initialSection, row.recommendedAction.kind === "review_updates" ? row.recommendedAction.baseSessionId : undefined)}
      onOpenSession={(sessionId) => void openStoredReviewBySessionId(dashboard.profile.id, sessionId)}
    />
  ) : (
    <Pending
      state={state}
      {...(dashboard === undefined ? {} : { dashboard })}
      {...(inbox === undefined ? {} : { inbox })}
      {...referenceProps}
      {...(openedPr === undefined ? {} : { openedPr })}
      {...(openError === undefined ? {} : { openError })}
      onOpenRow={(pr) => void openPullRequest(pr)}
    />
  );

  return <>
    {content}
    <Dialog open={preview?.confirmation.required === true} onOpenChange={(open) => { if (!open) setPreview(undefined); }}>
      {preview === undefined ? null : (
        <DialogContent initialFocus={() => document.getElementById("keep-current-profile")} finalFocus={previewTrigger}>
          <DialogHeader>
            <DialogTitle>Switch workspace profile</DialogTitle>
            <DialogDescription>Use the suggested profile before opening {preview.pr.owner}/{preview.pr.repo}#{preview.pr.number}.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button id="keep-current-profile" autoFocus variant="outline" onClick={() => setPreview(undefined)}>Keep current profile</Button>
            <Button onClick={() => void confirmEntry()}>Switch profile and open pull request</Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  </>;
}

export function InboxScreen({
  state,
  inbox,
  dashboard,
  reference,
  onReference,
  onPreview,
  onRefresh,
  refreshStatus,
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
  readonly refreshStatus: ReturnType<typeof inboxFreshnessLabel>;
  readonly onSettings: () => void;
  readonly onOpenReview: (
    row: InboxResponse["inbox"]["rows"][number],
    mode: ReviewStartMode,
    initialSection?: ReviewInitialSection,
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
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 max-sm:basis-full">
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
          <Button
            size="sm"
            className="shrink-0 text-xs max-sm:w-full"
            onClick={onPreview}
            disabled={state === "loading"}
          >
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
          {...(inbox.inbox.snapshot === undefined
            ? {}
            : { snapshot: inbox.inbox.snapshot })}
          refreshStatus={refreshStatus}
          onRefresh={onRefresh}
          onOpenReview={onOpenReview}
          onOpenSession={onOpenSession}
        />
      </div>
    </div>
  );
}

export function Pending({
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
      <Card className="mt-6">
        <CardContent className="flex flex-wrap items-end gap-3">
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
                Verify Git and GitHub access without exposing credentials.
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
        .filter(
          (repo) => repo.state !== "ready" && repo.state !== "no_open_prs",
        )
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
              {outcome === "github_auth"
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPreview(value: unknown): value is Preview {
  return isRecord(value) && isRecord(value.pr) && typeof value.pr.owner === "string" && typeof value.pr.repo === "string" && typeof value.pr.number === "number" && isRecord(value.confirmation) && typeof value.confirmation.required === "boolean";
}

function key(repo: {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}): string {
  return `${repo.host}/${repo.owner}/${repo.repo}`;
}
