import { useState } from "react";

export type DashboardScreenState =
  "empty" | "loading" | "success" | "degraded" | "error";

export type AppProps = {
  readonly initialState?: DashboardScreenState;
};

type View = "pending" | "settings";

const rows = [
  {
    id: 1842,
    title: "Cache role permissions from master data",
    author: "jessevu",
    priority: "Review requested",
    checks: "Passing",
    badges: ["Review requested"],
  },
  {
    id: 1817,
    title: "Add CRM contact export",
    author: "pmquan2cfw",
    priority: "Recently updated",
    checks: "Pending",
    badges: ["Authored"],
  },
];

/** Browserable, read-only dashboard shell for selecting an existing PR or entering one directly. */
export function App({ initialState = "empty" }: AppProps): React.JSX.Element {
  const [view, setView] = useState<View>("pending");
  const [entryOpen, setEntryOpen] = useState(false);
  const [reference, setReference] = useState("");
  const [showSwitch, setShowSwitch] = useState(false);
  const [localPath, setLocalPath] = useState("");

  const previewReference = (): void => {
    if (reference.includes("github.example.test")) setShowSwitch(true);
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto grid min-h-screen max-w-7xl grid-cols-[15rem_1fr]">
        <aside className="border-r border-slate-800 bg-slate-950 px-5 py-7">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-300">
            Local pull request review
          </p>
          <h1 className="mt-2 text-3xl font-semibold">Patchdesk</h1>
          <label
            className="mt-8 block text-sm text-slate-400"
            htmlFor="profile"
          >
            Workspace profile
          </label>
          <select
            id="profile"
            className="mt-2 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2"
            defaultValue="cfw"
          >
            <option value="cfw">CFW</option>
            <option value="enterprise">Enterprise</option>
          </select>
          <nav className="mt-8 space-y-1" aria-label="Patchdesk navigation">
            <button
              className="w-full rounded px-3 py-2 text-left hover:bg-slate-800"
              onClick={() => setView("pending")}
            >
              Pending PRs
            </button>
            <button
              className="w-full rounded px-3 py-2 text-left hover:bg-slate-800"
              onClick={() => setView("settings")}
            >
              Settings
            </button>
          </nav>
          <section
            className="mt-9 border-t border-slate-800 pt-5"
            aria-label="Watched repositories"
          >
            <h2 className="text-sm font-semibold text-slate-300">Watchlist</h2>
            <p className="mt-2 text-sm text-slate-400">
              centraldigital / cfw-bo-staff-api
            </p>
            <p className="text-xs text-slate-500">2 open pull requests</p>
          </section>
        </aside>

        <section className="px-8 py-7">
          {view === "pending" ? (
            <PendingDashboard
              state={initialState}
              entryOpen={entryOpen}
              onOpenEntry={() => setEntryOpen(true)}
              onCloseEntry={() => setEntryOpen(false)}
              reference={reference}
              onReferenceChange={setReference}
              onPreview={previewReference}
            />
          ) : (
            <Settings localPath={localPath} onLocalPathChange={setLocalPath} />
          )}
        </section>
      </div>
      {showSwitch ? (
        <section
          role="dialog"
          aria-modal="true"
          aria-label="Switch workspace profile"
          className="fixed inset-0 grid place-items-center bg-slate-950/80 p-6"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
            <h2 className="text-xl font-semibold">Switch workspace profile</h2>
            <p className="mt-3 text-slate-300">
              This pull request uses github.example.test. Switch from CFW to the
              suggested Enterprise profile before opening it.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                className="rounded border border-slate-600 px-3 py-2"
                onClick={() => setShowSwitch(false)}
              >
                Keep CFW
              </button>
              <button
                className="rounded bg-cyan-500 px-3 py-2 font-medium text-slate-950"
                onClick={() => setShowSwitch(false)}
              >
                Switch profile
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function PendingDashboard({
  state,
  entryOpen,
  onOpenEntry,
  onCloseEntry,
  reference,
  onReferenceChange,
  onPreview,
}: {
  readonly state: DashboardScreenState;
  readonly entryOpen: boolean;
  readonly onOpenEntry: () => void;
  readonly onCloseEntry: () => void;
  readonly reference: string;
  readonly onReferenceChange: (value: string) => void;
  readonly onPreview: () => void;
}): React.JSX.Element {
  return (
    <>
      <header className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm text-slate-400">CFW / pmquan2cfw</p>
          <h2 className="mt-1 text-2xl font-semibold">Pending pull requests</h2>
        </div>
        <div className="flex gap-3">
          <button
            className="rounded border border-slate-700 px-3 py-2"
            onClick={onOpenEntry}
          >
            Open pull request
          </button>
          <button className="rounded bg-slate-800 px-3 py-2">Refresh</button>
        </div>
      </header>
      {state === "empty" ? <EmptyWatchlist onOpenEntry={onOpenEntry} /> : null}
      {state === "loading" ? <LoadingRows /> : null}
      {state === "error" ? (
        <DashboardNotice
          title="GitHub access unavailable"
          detail="Refresh the watchlist after GitHub authentication is available. Direct PR entry remains available."
          tone="error"
        />
      ) : null}
      {state === "degraded" ? (
        <DashboardNotice
          title="Missing local path"
          detail="GitHub metadata is available, but this repo has no local checkout configured. You can still open a PR directly."
          tone="warning"
        />
      ) : null}
      {state === "success" || state === "degraded" ? <PrRows /> : null}
      {entryOpen ? (
        <section
          className="mt-6 rounded-xl border border-slate-700 bg-slate-900 p-5"
          aria-label="Direct pull request entry"
        >
          <h3 className="text-lg font-semibold">Open a pull request</h3>
          <p className="mt-1 text-sm text-slate-400">
            Paste a GitHub PR URL or use owner/repo#123. This does not start a
            review.
          </p>
          <label className="mt-4 block text-sm" htmlFor="pr-reference">
            Pull request reference
          </label>
          <input
            id="pr-reference"
            className="mt-2 w-full rounded border border-slate-600 bg-slate-950 px-3 py-2"
            value={reference}
            onChange={(event) => onReferenceChange(event.target.value)}
            placeholder="centraldigital/repo#123"
          />
          <div className="mt-4 flex gap-3">
            <button
              className="rounded bg-cyan-500 px-3 py-2 font-medium text-slate-950"
              onClick={onPreview}
            >
              Preview pull request
            </button>
            <button
              className="rounded border border-slate-600 px-3 py-2"
              onClick={onCloseEntry}
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}

function EmptyWatchlist({
  onOpenEntry,
}: {
  readonly onOpenEntry: () => void;
}): React.JSX.Element {
  return (
    <section className="mt-8 rounded-xl border border-dashed border-slate-700 bg-slate-900/70 p-8">
      <h3 className="text-lg font-semibold">Your watchlist is empty</h3>
      <p className="mt-2 text-slate-400">
        Open a pull request to begin a local review.
      </p>
      <p className="mt-1 text-sm text-slate-500">
        Add watched repos from Settings when you are ready.
      </p>
      <button
        className="mt-5 rounded bg-cyan-500 px-3 py-2 font-medium text-slate-950"
        onClick={onOpenEntry}
      >
        Open pull request
      </button>
    </section>
  );
}

function LoadingRows(): React.JSX.Element {
  return (
    <div className="mt-8 space-y-3" aria-label="Loading pull requests">
      <div className="h-16 animate-pulse rounded bg-slate-800" />
      <div className="h-16 animate-pulse rounded bg-slate-800" />
    </div>
  );
}

function DashboardNotice({
  title,
  detail,
  tone,
}: {
  readonly title: string;
  readonly detail: string;
  readonly tone: "warning" | "error";
}): React.JSX.Element {
  return (
    <section
      className={`mt-7 rounded-lg border p-4 ${tone === "error" ? "border-red-900 bg-red-950/40" : "border-amber-800 bg-amber-950/30"}`}
    >
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-slate-300">{detail}</p>
    </section>
  );
}

function PrRows(): React.JSX.Element {
  return (
    <section className="mt-7 overflow-hidden rounded-xl border border-slate-800">
      <div className="grid grid-cols-[1fr_auto_auto] gap-4 border-b border-slate-800 px-5 py-3 text-xs uppercase tracking-wide text-slate-400">
        <span>Pull request</span>
        <span>Checks</span>
        <span>Priority</span>
      </div>
      {rows.map((row) => (
        <button
          key={row.id}
          className="grid w-full grid-cols-[1fr_auto_auto] gap-4 border-b border-slate-800 px-5 py-4 text-left hover:bg-slate-900"
        >
          <span>
            <strong>
              #{row.id} {row.title}
            </strong>
            <small className="mt-1 block text-slate-400">{row.author}</small>
          </span>
          <span className="text-sm text-slate-300">{row.checks}</span>
          <span className="rounded bg-slate-800 px-2 py-1 text-xs text-cyan-200">
            {row.badges.join(", ")}
          </span>
        </button>
      ))}
    </section>
  );
}

function Settings({
  localPath,
  onLocalPathChange,
}: {
  readonly localPath: string;
  readonly onLocalPathChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <>
      <header>
        <p className="text-sm text-slate-400">Local configuration only</p>
        <h2 className="mt-1 text-2xl font-semibold">Watchlist settings</h2>
      </header>
      <section className="mt-7 rounded-xl border border-slate-800 bg-slate-900 p-6">
        <h3 className="font-semibold">centraldigital / cfw-bo-staff-api</h3>
        <p className="mt-1 text-sm text-slate-400">
          GitHub metadata is read-only. No GitHub write action is available
          here.
        </p>
        <label className="mt-5 block text-sm" htmlFor="local-path">
          Local path
        </label>
        <input
          id="local-path"
          className="mt-2 w-full rounded border border-slate-600 bg-slate-950 px-3 py-2"
          value={localPath}
          onChange={(event) => onLocalPathChange(event.target.value)}
          placeholder="/Users/you/Work/cfw/cfw-bo-staff-api"
        />
        <div className="mt-5 flex gap-3">
          <button className="rounded bg-cyan-500 px-3 py-2 font-medium text-slate-950">
            Save local path
          </button>
          <button className="rounded border border-slate-600 px-3 py-2">
            Test GitHub access
          </button>
          <button className="rounded border border-red-900 px-3 py-2 text-red-200">
            Remove repo
          </button>
        </div>
      </section>
    </>
  );
}
