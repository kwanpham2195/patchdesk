import { useEffect, useState } from "react";
import { DiffWorkbench } from "./components/diff-workbench";
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
    readonly ref: { readonly number: number };
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
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  };
  readonly confirmation: {
    readonly required: boolean;
    readonly targetProfileId?: string;
  };
};

/** Renderer-only dashboard: every product value is loaded from the authenticated local API. */
export function App({ initialState }: AppProps): React.JSX.Element {
  const diffFixture = typeof window !== "undefined" && window.location.hash === "#diff-fixture";
  const runFixture = typeof window !== "undefined" && window.location.hash === "#run-fixture";
  const [view, setView] = useState<View>("pending");
  const [profiles, setProfiles] = useState<ReadonlyArray<Profile>>([]);
  const [dashboard, setDashboard] = useState<Dashboard | undefined>();
  const [state, setState] = useState<DashboardScreenState>(
    initialState ?? "loading",
  );
  const [reference, setReference] = useState("");
  const [preview, setPreview] = useState<Preview | undefined>();
  const [openedPr, setOpenedPr] = useState<string | undefined>();
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
  if (runFixture) return <SafeRunPanel sessionId="fixture-session" attemptId="001" />;

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
    setOpenedPr(`${value.pr.owner}/${value.pr.repo}#${value.pr.number}`);
  };
  const confirmEntry = async (): Promise<void> => {
    if (preview === undefined) return;
    if (preview.confirmation.targetProfileId !== undefined)
      await select(preview.confirmation.targetProfileId);
    setOpenedPr(`${preview.pr.owner}/${preview.pr.repo}#${preview.pr.number}`);
    setPreview(undefined);
  };

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
              {...(openedPr === undefined ? {} : { openedPr })}
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

function Pending({
  state,
  dashboard,
  reference,
  onReference,
  onPreview,
  onRefresh,
  openedPr,
}: {
  readonly state: DashboardScreenState;
  readonly dashboard?: Dashboard;
  readonly reference: string;
  readonly onReference: (value: string) => void;
  readonly onPreview: () => void;
  readonly onRefresh: () => void;
  readonly openedPr?: string;
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
