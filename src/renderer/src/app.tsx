import { useCallback, useEffect, useState } from "react";
import { DiffWorkbench } from "./components/diff-workbench";
import { ReviewWorkbench } from "./components/review-workbench";
import { ReviewSubmissionDialog } from "./components/review-submission-dialog";
import { MergeConfirmationDialog } from "./components/merge-confirmation-dialog";
import { SafeRunPanel } from "./components/safe-run-panel";

export type DashboardScreenState =
  | "empty"
  | "loading"
  | "success"
  | "degraded"
  | "error"
  | "archived"
  | "no_open_prs";
export type AppProps = { readonly initialState?: DashboardScreenState };
type View = "pending" | "settings";
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
    readonly ref: { readonly host: string; readonly owner: string; readonly repo: string; readonly number: number };
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
  readonly session: { readonly id: string; readonly key: { readonly profileId: string; readonly owner: string; readonly repo: string; readonly prNumber: number; readonly headSha: string }; readonly currentAttemptId?: string; readonly draftContent?: unknown };
  readonly result?: unknown;
  readonly draft?: unknown;
  readonly comments?: unknown;
  readonly checks?: unknown;
  readonly history?: unknown;
  readonly mergeReadiness?: unknown;
};

/** Renderer-only dashboard: every product value is loaded from the authenticated local API. */
export function App({ initialState }: AppProps): React.JSX.Element {
  const diffFixture = typeof window !== "undefined" && window.location.hash === "#diff-fixture";
  const runFixture = typeof window !== "undefined" && window.location.hash === "#run-fixture";
  const workbenchFixture = typeof window !== "undefined" && window.location.hash === "#workbench-fixture";
  const submissionFixture = typeof window !== "undefined" && window.location.hash === "#submission-fixture";
  const submissionRejectionFixture = typeof window !== "undefined" && window.location.hash === "#submission-rejection-fixture";
  const mergeFixture = typeof window !== "undefined" && window.location.hash === "#merge-fixture";
  const [view, setView] = useState<View>("pending");
  const [profiles, setProfiles] = useState<ReadonlyArray<Profile>>([]);
  const [dashboard, setDashboard] = useState<Dashboard | undefined>();
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
  const [suggestions, setSuggestions] = useState<ReadonlyArray<Repo>>([]);
  const [githubAccess, setGithubAccess] = useState<string | undefined>();
  const [profileDraft, setProfileDraft] = useState({
    id: "",
    label: "",
    githubHost: "github.com",
    ghAccount: "",
    workspaceRoot: "",
  });
  const loadCompletedWorkbench = useCallback(async (profileId: string, sessionId: string): Promise<void> => {
    const value = await api("/v1/reviews/load", { method: "POST", body: { profileId, sessionId } });
    if (isWorkbenchPayload(value)) setWorkbench(value);
  }, []);

  const load = async (): Promise<void> => {
    if (typeof window === "undefined" || !("patchdesk" in window)) {
      setState(initialState ?? "empty");
      return;
    }
    setState("loading");
    const [profilePayload, dashboardPayload] = await Promise.all([
      api("/v1/profiles"),
      api("/v1/dashboard"),
    ]);
    if (Array.isArray(profilePayload))
      setProfiles(profilePayload.filter(isProfile));
    if (isDashboard(dashboardPayload)) {
      setDashboard(dashboardPayload);
      setProfileDraft({
        id: dashboardPayload.profile.id,
        label: dashboardPayload.profile.label,
        githubHost: dashboardPayload.profile.githubHost,
        ghAccount: dashboardPayload.profile.ghAccount,
        workspaceRoot: dashboardPayload.profile.workspaceRoots?.[0] ?? "",
      });
      const outcomes = dashboardPayload.dashboard.repos.map(
        (item) => item.state,
      );
      setState(
        outcomes.includes("github_auth") || outcomes.includes("github_read")
          ? "error"
          : outcomes.includes("archived")
            ? "archived"
            : outcomes.includes("no_open_prs") &&
                dashboardPayload.dashboard.rows.length === 0
              ? "no_open_prs"
              : outcomes.includes("missing_local_path")
                ? "degraded"
                : dashboardPayload.dashboard.rows.length === 0
                  ? "empty"
                  : "success",
      );
    } else if (initialState === undefined) setState("empty");
  };
  useEffect(() => {
    void load();
  }, []);

  if (diffFixture) return <DiffWorkbench patch={fixturePatch} finding={{ file: "src/b.ts", lineStart: 1, diffSide: "new" }} />;
  if (runFixture) return <SafeRunPanel profileId="fixture" sessionId="fixture-session" attemptId="001" />;
  if (workbenchFixture) return <ReviewWorkbench result={workbenchFixtureData.result as never} draft={workbenchFixtureData.draft} comments={workbenchFixtureData.comments as never} checks={workbenchFixtureData.checks} history={workbenchFixtureData.history} debugHref={workbenchFixtureData.debugHref} />;
  if (submissionFixture) return <main className="min-h-screen bg-slate-950 px-6 py-8 text-slate-100"><div className="mx-auto max-w-3xl"><ReviewSubmissionDialog draft={submissionFixtureData.draft as never} findings={submissionFixtureData.findings as never} onCreatePending={async () => ({ reviewId: "9001" })} onSubmitPending={async () => ({ reviewId: "9001" })} /></div></main>;
  if (submissionRejectionFixture) return <main className="min-h-screen bg-slate-950 px-6 py-8 text-slate-100"><div className="mx-auto max-w-3xl"><ReviewSubmissionDialog draft={submissionFixtureData.draft as never} findings={submissionFixtureData.findings as never} onCreatePending={async () => { throw new Error("fixture rejection"); }} onSubmitPending={async () => ({ reviewId: "9001" })} /></div></main>;
  if (mergeFixture) return <main className="min-h-screen bg-slate-950 px-6 py-8 text-slate-100"><div className="mx-auto max-w-3xl"><MergeConfirmationDialog readiness={{ _tag: "NeedsAcknowledgement", blockers: [], warnings: ["request_changes", "high_severity_finding"] }} context={{ repo: "centraldigital/patchdesk", prNumber: 42, title: "Protect review writes", base: "sit", head: "feat/review", headSha: "abcdef1234567890" }} methods={["squash", "merge"]} onMerge={async () => ({ mergeCommitSha: "abcdef" })} /></div></main>;

  if (workbench?.state === "review_started") return <main className="min-h-screen bg-slate-950 px-6 py-8 text-slate-100"><section className="mx-auto max-w-3xl rounded-xl border border-slate-800 bg-slate-900 p-6" aria-label="Review in progress"><p className="text-xs uppercase tracking-[.2em] text-cyan-300">Review session started</p><h1 className="mt-2 text-2xl font-semibold">Preparing the persisted review workbench</h1><p className="mt-3 text-sm text-slate-300">Session {workbench.session.id}</p>{workbench.session.currentAttemptId === undefined ? <p className="mt-3 text-sm text-slate-400">The review has been recorded locally and will appear here when its result is complete.</p> : <SafeRunPanel profileId={workbench.session.key.profileId} sessionId={workbench.session.id} attemptId={workbench.session.currentAttemptId} onCompleted={loadCompletedWorkbench} />}</section></main>;

  if (workbench?.state === "completed" && dashboard !== undefined) return <ReviewWorkbench result={workbench.result as never} draft={{ summaryBody: (workbench.draft as { readonly summaryBody?: string } | undefined)?.summaryBody ?? "", comments: ((workbench.draft as { readonly comments?: ReadonlyArray<{ readonly findingId: string; readonly body: string; readonly postability: "postable" }> } | undefined)?.comments ?? []) }} comments={workbench.comments as never} checks={workbench.checks as never} history={workbench.history as never ?? []} debugHref={`/debug/${workbench.session.id}`} submission={{ draft: workbench.draft as never, onCreatePending: async () => reviewWrite("/v1/reviews/pending"), onSubmitPending: async (event, summaryBody) => reviewWrite("/v1/reviews/submit", { event, summaryBody }) }} merge={{ readiness: workbench.mergeReadiness as never, context: { repo: `${workbench.session.key.owner}/${workbench.session.key.repo}`, prNumber: workbench.session.key.prNumber, title: (workbench.result as { readonly changeSummary?: string } | undefined)?.changeSummary ?? "Pull request", base: "base", head: "head", headSha: workbench.session.key.headSha }, methods: ["squash", "merge", "rebase"], onMerge: async (method, acknowledgedWarnings) => mergeReview(method, acknowledgedWarnings) }} />;

  const select = async (id: string): Promise<void> => {
    await api("/v1/profiles/select", { method: "POST", body: { id } });
    await load();
  };
  const refreshDashboard = async (): Promise<void> => {
    await api("/v1/dashboard/refresh", { method: "POST" });
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
  const previewEntry = async (): Promise<void> => {
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
  async function openPullRequest(pr: Preview["pr"]): Promise<void> {
    setOpenedPr(undefined);
    setOpenError(undefined);
    const value = await api("/v1/reviews/open", { method: "POST", body: { profileId: dashboard?.profile.id, host: pr.host ?? dashboard?.profile.githubHost, owner: pr.owner, repo: pr.repo, number: pr.number } });
    if (isWorkbenchPayload(value)) {
      setOpenedPr(`${pr.owner}/${pr.repo}#${pr.number}`);
      setWorkbench(value);
    } else {
      setOpenError(`Could not prepare ${pr.owner}/${pr.repo}#${pr.number}.`);
    }
  }
  async function reviewWrite(path: string, extra: Record<string, unknown> = {}): Promise<{ readonly reviewId: string }> {
    if (workbench === undefined || dashboard === undefined || workbench.draft === undefined) throw new Error("Review workbench is unavailable");
    const value = await api(path, { method: "POST", body: { profileId: dashboard.profile.id, sessionId: workbench.session.id, draft: workbench.draft, ...extra } });
    if (!isWorkbenchWrite(value)) throw new Error("Review write was rejected");
    setWorkbench((current) => current === undefined ? current : { ...current, session: value.session as WorkbenchPayload["session"], draft: value.draft });
    const state = value.draft.state as { readonly pendingReviewId?: string; readonly reviewId?: string };
    return { reviewId: state.reviewId ?? state.pendingReviewId ?? "review" };
  }
  async function mergeReview(method: "merge" | "squash" | "rebase", acknowledgedWarnings: boolean): Promise<{ readonly mergeCommitSha?: string }> {
    if (workbench === undefined || dashboard === undefined) throw new Error("Review workbench is unavailable");
    const value = await api("/v1/reviews/merge", { method: "POST", body: { profileId: dashboard.profile.id, sessionId: workbench.session.id, method, acknowledgedWarnings } });
    if (!record(value) || !record(value.session)) throw new Error("Merge was rejected");
    setWorkbench((current) => current === undefined ? current : { ...current, session: value.session as WorkbenchPayload["session"] });
    const mergeCommitSha = record(value.session.mergeDecision) && typeof value.session.mergeDecision.mergeCommitSha === "string" ? value.session.mergeDecision.mergeCommitSha : undefined;
    return mergeCommitSha === undefined ? {} : { mergeCommitSha };
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto grid min-h-screen max-w-7xl grid-cols-[15rem_1fr]">
        <aside className="border-r border-slate-800 px-5 py-7">
          <p className="text-xs uppercase tracking-[.2em] text-cyan-300">
            Local pull request review
          </p>
          <h1 className="mt-2 text-3xl font-semibold">Patchdesk</h1>
          <label className="mt-8 block text-sm" htmlFor="profile">
            Workspace profile
          </label>
          <select
            id="profile"
            className="mt-2 w-full rounded bg-slate-900 p-2"
            value={dashboard?.profile.id ?? ""}
            onChange={(event) => void select(event.target.value)}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}
              </option>
            ))}
          </select>
          <nav className="mt-8 space-y-1">
            <button
              className="block w-full p-2 text-left"
              onClick={() => setView("pending")}
            >
              Pending PRs
            </button>
            <button
              className="block w-full p-2 text-left"
              onClick={() => setView("settings")}
            >
              Settings
            </button>
          </nav>
          <section className="mt-8 border-t border-slate-800 pt-4">
            <h2>Watchlist</h2>
            {dashboard?.dashboard.repos.map(({ repo, state: outcome }) => (
              <p key={key(repo)} className="mt-2 text-sm">
                {repo.owner}/{repo.repo}{" "}
                <small className="text-slate-400">{outcome}</small>{" "}
                <button
                  aria-label={`Refresh ${repo.owner}/${repo.repo}`}
                  onClick={() => void refreshRepo(repo)}
                >
                  Refresh repo
                </button>
              </p>
            ))}
          </section>
        </aside>
        <section className="px-8 py-7">
          {view === "pending" ? (
            <Pending
              state={state}
              {...(dashboard === undefined ? {} : { dashboard })}
              reference={reference}
              onReference={setReference}
              onPreview={() => void previewEntry()}
              onRefresh={() => void refreshDashboard()}
              onOpenRow={(pr) => void openPullRequest(pr)}
              {...(openedPr === undefined ? {} : { openedPr })}
              {...(openError === undefined ? {} : { openError })}
            />
          ) : (
            <Settings
              {...(dashboard === undefined ? {} : { dashboard })}
              paths={paths}
              setPaths={setPaths}
              newRepo={newRepo}
              setNewRepo={setNewRepo}
              profileDraft={profileDraft}
              setProfileDraft={setProfileDraft}
              suggestions={suggestions}
              {...(githubAccess === undefined ? {} : { githubAccess })}
              onAdd={() => void addRepo()}
              onSaveProfile={() => void saveProfile()}
              onDiscover={() => void discover()}
              onAddSuggestion={(repo) => void addSuggestion(repo)}
              onTestGitHubAccess={() => void testGitHubAccess()}
              onPath={editPath}
              onRemove={remove}
              onArchive={archive}
              onRefreshRepo={refreshRepo}
            />
          )}
        </section>
      </div>
      {preview?.confirmation.required ? (
        <section
          role="dialog"
          aria-label="Switch workspace profile"
          className="fixed inset-0 grid place-items-center bg-slate-950/80"
        >
          <div className="rounded bg-slate-900 p-6">
            <h2>Switch workspace profile</h2>
            <p className="mt-2">
              Use the suggested profile before opening {preview.pr.owner}/
              {preview.pr.repo}#{preview.pr.number}.
            </p>
            <button
              className="mt-4 rounded bg-cyan-500 p-2 text-slate-950"
              onClick={() => void confirmEntry()}
            >
              Switch profile and open pull request
            </button>
            <button className="ml-3" onClick={() => setPreview(undefined)}>
              Keep current profile
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}

const fixturePatch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-old\n+new\n";

const workbenchFixtureData = {
  result: {
    changeSummary: "Review completed for Patchdesk workbench",
    verdict: "comment",
    summary: "One mapped finding and one finding that needs manual placement.",
    findings: [
      { id: "mapped", severity: "P1", title: "Keep writes behind the stale-head check", file: "src/services/review-workbench.ts", lineStart: 42, diffSide: "new", explanation: "A GitHub adapter must never bypass the current head check.", suggestedComment: "Keep the stale-head check at the write boundary.", confidence: "high", mappingStatus: "mapped" },
      { id: "unmapped", severity: "P2", title: "Document the manual placement", explanation: "This review point has no verified diff coordinate.", confidence: "medium", mappingStatus: "unmapped" },
    ],
    validationPlan: ["pnpm test -- --run review-workbench", "pnpm test:e2e -- --grep completed-review"],
    assumptions: ["The head SHA remains current while this local draft is edited."],
  },
  draft: { summaryBody: "One mapped finding and one finding that needs manual placement.", comments: [{ findingId: "mapped", body: "Keep the stale-head check at the write boundary.", postability: "postable" as const }] },
  comments: { threads: [{ id: "thread-1", state: "open" as const, location: { path: "src/services/review-workbench.ts", line: 42 }, comments: [{ id: "comment-1", author: "reviewer", body: "Existing GitHub review comment.", createdAt: "2026-07-16T00:00:00.000Z" as never, url: "https://github.com/centraldigital/patchdesk/pull/1#discussion_r1" }] }] },
  checks: { overall: "failing" as const, checks: [{ name: "unit", required: true as const, status: "completed" as const, conclusion: "failure" as const, url: "https://github.com/centraldigital/patchdesk/actions/runs/1" }, { name: "docs", required: false as const, status: "queued" as const }] },
  history: [{ id: "001", state: "ReviewCompleted" as const }, { id: "002", state: "ReviewFailed" as const }, { id: "003", state: "Stale" as const }, { id: "004", state: "Discarded" as const }, { id: "005", state: "Merged" as const }, { id: "006", state: "IgnoredLateResult" as const }],
  debugHref: "/debug/fixture-session",
};

const submissionFixtureData = {
  draft: {
    state: { _tag: "LocalDraft" },
    summaryBody: "Request changes before merge.",
    comments: [
      { findingId: "p1", include: true, path: "src/services/review-submission-service.ts", line: 34, body: "Keep the stale-head check at the write boundary.", postability: "postable" },
      { findingId: "unmapped", include: true, path: "src/services/review-submission-service.ts", line: 55, body: "This has no verified GitHub location.", postability: "invalid_line" },
    ],
  },
  findings: [{ id: "p1", severity: "P1" }],
};

function Pending({
  state,
  dashboard,
  reference,
  onReference,
  onPreview,
  onRefresh,
  onOpenRow,
  openedPr,
  openError,
}: {
  readonly state: DashboardScreenState;
  readonly dashboard?: Dashboard;
  readonly reference: string;
  readonly onReference: (value: string) => void;
  readonly onPreview: () => void;
  readonly onRefresh: () => void;
  readonly onOpenRow: (pr: Preview["pr"]) => void;
  readonly openedPr?: string;
  readonly openError?: string;
}): React.JSX.Element {
  return (
    <>
      <header className="flex justify-between">
        <div>
          <p className="text-slate-400">
            {dashboard?.profile.label ?? "First run"}
          </p>
          <h2 className="text-2xl font-semibold">Pending pull requests</h2>
        </div>
        <button onClick={onRefresh}>Refresh</button>
        <button onClick={onPreview}>Open pull request</button>
      </header>
      {openedPr ? (
        <p className="mt-4 rounded bg-cyan-950 p-3">Opened {openedPr}</p>
      ) : null}
      {openError ? <p role="alert" className="mt-4 rounded bg-red-950 p-3">{openError}</p> : null}
      <section className="mt-6 rounded border border-slate-800 p-4">
        <label htmlFor="pr-reference">Pull request reference</label>
        <input
          id="pr-reference"
          className="ml-3 rounded bg-slate-900 p-2"
          value={reference}
          onChange={(event) => onReference(event.target.value)}
        />
        <button className="ml-3" onClick={onPreview}>
          Preview pull request
        </button>
      </section>
      <Outcome state={state} repos={dashboard?.dashboard.repos ?? []} />
      <section className="mt-6">
        {dashboard?.dashboard.rows.map((row) => (
          <article
            key={row.summary.ref.number}
            className="border-b border-slate-800 py-3"
          >
            <strong>
              #{row.summary.ref.number} {row.summary.title}
            </strong>
            <p className="text-sm text-slate-400">
              {row.summary.author} ·{" "}
              {row.summary.checkSummary?.overall ?? "unknown"} ·{" "}
              {row.badges.join(", ") || row.priority}
            </p>
            <button className="mt-2 text-sm text-cyan-300" onClick={() => onOpenRow(row.summary.ref)}>Open review</button>
          </article>
        ))}
      </section>
    </>
  );
}
function Outcome({
  state,
  repos,
}: {
  readonly state: DashboardScreenState;
  readonly repos: ReadonlyArray<RepoOutcome>;
}): React.JSX.Element {
  if (state === "loading") return <p className="mt-6">Loading dashboard…</p>;
  if (state === "empty")
    return (
      <>
        <p className="mt-6">Open a pull request to begin a local review.</p>
        <p>Add a repo in Settings or enter a PR directly.</p>
      </>
    );
  if (state === "degraded") return <p className="mt-6">Missing local path</p>;
  return (
    <section className="mt-6 space-y-2">
      {repos
        .filter((repo) => repo.state !== "ready")
        .map(({ repo, state: outcome }) => (
          <p key={key(repo)}>
            {repo.owner}/{repo.repo}:{" "}
            {outcome === "no_open_prs"
              ? "No pending pull requests"
              : outcome === "github_auth"
                ? "GitHub authentication required"
                : outcome === "github_read"
                  ? "GitHub metadata unavailable"
                  : outcome === "archived"
                    ? "Archived repository"
                    : outcome === "missing_local_path"
                      ? "Missing local path"
                      : outcome}
          </p>
        ))}
    </section>
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
  githubAccess,
  onAdd,
  onSaveProfile,
  onDiscover,
  onAddSuggestion,
  onTestGitHubAccess,
  onPath,
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
  readonly githubAccess?: string;
  readonly onAdd: () => void;
  readonly onSaveProfile: () => void;
  readonly onDiscover: () => void;
  readonly onAddSuggestion: (repo: Repo) => void;
  readonly onTestGitHubAccess: () => void;
  readonly onPath: (repo: Repo) => void;
  readonly onRemove: (repo: Repo) => void;
  readonly onArchive: (repo: Repo) => void;
  readonly onRefreshRepo: (repo: Repo) => void;
}): React.JSX.Element {
  return (
    <>
      <h2 className="text-2xl font-semibold">Watchlist settings</h2>
      <section className="mt-4 border border-slate-800 p-4">
        <h3>Workspace profile</h3>
        <label>
          Profile ID
          <input
            value={profileDraft.id}
            onChange={(event) =>
              setProfileDraft((current) => ({
                ...current,
                id: event.target.value,
              }))
            }
          />
        </label>
        <label>
          Label
          <input
            value={profileDraft.label}
            onChange={(event) =>
              setProfileDraft((current) => ({
                ...current,
                label: event.target.value,
              }))
            }
          />
        </label>
        <label>
          GitHub host
          <input
            value={profileDraft.githubHost}
            onChange={(event) =>
              setProfileDraft((current) => ({
                ...current,
                githubHost: event.target.value,
              }))
            }
          />
        </label>
        <label>
          GitHub account
          <input
            value={profileDraft.ghAccount}
            onChange={(event) =>
              setProfileDraft((current) => ({
                ...current,
                ghAccount: event.target.value,
              }))
            }
          />
        </label>
        <label>
          Workspace root
          <input
            value={profileDraft.workspaceRoot}
            onChange={(event) =>
              setProfileDraft((current) => ({
                ...current,
                workspaceRoot: event.target.value,
              }))
            }
            placeholder="/absolute/workspace/path"
          />
        </label>
        <button onClick={onSaveProfile}>Save profile</button>
      </section>
      <div className="mt-4">
        <label htmlFor="repo-add">Repository</label>
        <input
          id="repo-add"
          value={newRepo}
          onChange={(event) => setNewRepo(event.target.value)}
          placeholder="owner/repo"
        />
        <button onClick={onAdd}>Add repo</button>
      </div>
      <section className="mt-4">
        <button onClick={onDiscover}>Discover workspace repos</button>
        <button className="ml-3" onClick={onTestGitHubAccess}>
          Test GitHub access
        </button>
        {githubAccess === undefined ? null : (
          <p>GitHub access: {githubAccess}</p>
        )}
        {suggestions.map((repo) => (
          <p key={key(repo)}>
            {repo.owner}/{repo.repo}{" "}
            <button onClick={() => onAddSuggestion(repo)}>
              Add suggestion
            </button>
          </p>
        ))}
      </section>
      {dashboard?.dashboard.repos.map(({ repo }) => (
        <section key={key(repo)} className="mt-5 border border-slate-800 p-4">
          <h3>
            {repo.owner}/{repo.repo}
          </h3>
          <label>
            Local path{" "}
            <input
              value={paths[key(repo)] ?? repo.localPath ?? ""}
              onChange={(event) =>
                setPaths((current) => ({
                  ...current,
                  [key(repo)]: event.target.value,
                }))
              }
            />
          </label>
          <button onClick={() => onPath(repo)}>Save path</button>
          <button onClick={() => onRemove(repo)}>Remove repo</button>
          <button onClick={() => onRefreshRepo(repo)}>Refresh repo</button>
          <button onClick={() => onArchive(repo)}>
            {repo.archived ? "Restore repo" : "Archive repo"}
          </button>
        </section>
      ))}
    </>
  );
}
async function api(
  path: string,
  init: { readonly method?: string; readonly body?: unknown } = {},
): Promise<unknown> {
  if (typeof window === "undefined" || !("patchdesk" in window))
    return undefined;
  const response = await fetch(
    new URL(path.slice(1), window.patchdesk.localApi.baseUrl),
    {
      ...(init.method === undefined ? {} : { method: init.method }),
      headers: {
        "Content-Type": "application/json",
        "X-Patchdesk-Capability": window.patchdesk.localApi.capability,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
  ).catch(() => undefined);
  return response?.ok
    ? await response.json().catch(() => undefined)
    : undefined;
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
function isDashboard(value: unknown): value is Dashboard {
  return (
    record(value) &&
    isProfile(value.profile) &&
    record(value.dashboard) &&
    Array.isArray(value.dashboard.rows) &&
    Array.isArray(value.dashboard.repos)
  );
}
function isWorkbenchPayload(value: unknown): value is WorkbenchPayload {
  return record(value) && (value.state === "review_started" || value.state === "completed") && record(value.session) && typeof value.session.id === "string";
}
function isWorkbenchWrite(value: unknown): value is { readonly session: unknown; readonly draft: { readonly state: unknown } } {
  return record(value) && "session" in value && record(value.draft) && "state" in value.draft;
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
