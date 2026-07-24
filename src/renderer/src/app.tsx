import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "./components/app-shell";
import type {
  ReviewInitialSection,
  ReviewStartMode,
} from "./components/maintainer-inbox";
import { PreparedReviewFlow } from "./flows/prepared-review-flow";
import { CompletedReviewFlow } from "./flows/completed-review-flow";
import { AppFixtureContent } from "./flows/app-fixtures";
import { fixtureDestination, isFixtureHash } from "./flows/fixture-routes";
import { InboxScreen, Pending, ReviewRecords } from "./flows/inbox-flow";
import { SettingsFlow } from "./flows/settings-flow";
import type {
  Dashboard,
  DashboardScreenState,
  Preview,
  Profile,
  Repo,
  ReviewRecord,
  WorkbenchPayload,
} from "./renderer-models";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { TooltipProvider } from "./components/ui/tooltip";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import type { AppDestination } from "./routes";
import { destinationKey, parseDestination } from "./routes";
import { PatchdeskApiError, requestJson, selectDirectory } from "./api-client";
import {
  parseInboxResponse,
  parseWorkbenchResponse,
  type InboxResponse,
} from "./renderer-contracts";
import {
  InboxRefreshScheduler,
  inboxFreshnessLabel,
} from "./inbox-refresh-scheduler";
import {
  applyAppearance,
  loadAppearancePreference,
  saveAppearancePreference,
  type AppearancePreference,
} from "./appearance-preferences";
import {
  loadDiffThemePreferences,
  saveDiffThemePreferences,
  type DiffThemePreferences,
} from "./diff-theme-preferences";

export type AppProps = { readonly initialState?: DashboardScreenState };

/** Renderer-only dashboard: every product value is loaded from the authenticated local API. */
export function App({ initialState }: AppProps): React.JSX.Element {
  const fixtureHash = typeof window === "undefined" ? "" : window.location.hash;
  const fixtureMode = isFixtureHash(fixtureHash);
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
  const [inboxRefreshing, setInboxRefreshing] = useState(false);
  const [inboxPaused, setInboxPaused] = useState(false);
  const [inboxRefreshFailed, setInboxRefreshFailed] = useState(false);
  const [state, setState] = useState<DashboardScreenState>(
    initialState ?? "loading",
  );
  const [reference, setReference] = useState("");
  const [preview, setPreview] = useState<Preview | undefined>();
  const [openedPr, setOpenedPr] = useState<string | undefined>();
  const [openError, setOpenError] = useState<string | undefined>();
  const [workbench, setWorkbench] = useState<WorkbenchPayload | undefined>();
  const [appearance, setAppearance] = useState<AppearancePreference>(() =>
    loadAppearancePreference(),
  );
  const [diffThemePreferences, setDiffThemePreferences] =
    useState<DiffThemePreferences>(() => loadDiffThemePreferences());

  useEffect(() => {
    const apply = (): void => {
      applyAppearance(appearance);
    };
    apply();
    if (typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [appearance]);
  const [newRepo, setNewRepo] = useState("");
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [pathFeedback, setPathFeedback] = useState<string>();
  const [suggestions, setSuggestions] = useState<ReadonlyArray<Repo>>([]);
  const [discoveryFeedback, setDiscoveryFeedback] = useState<string>();
  const [reviewRecords, setReviewRecords] = useState<
    ReadonlyArray<ReviewRecord>
  >([]);
  const [reviewRecordsState, setReviewRecordsState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [invalidReviewRecordCount, setInvalidReviewRecordCount] = useState(0);
  const restoredSessionId = useRef<string | undefined>(undefined);
  const activeInboxProfileId = useRef<string | undefined>(undefined);
  const inboxRefreshGeneration = useRef(0);
  const inboxRefreshScheduler = useRef<InboxRefreshScheduler | undefined>(
    undefined,
  );
  const inboxSchedulerInitialized = useRef(false);
  const [navigationState, setNavigationState] = useState<
    "clear" | "dirty_draft" | "write_pending"
  >("clear");
  const [pendingDestination, setPendingDestination] =
    useState<AppDestination>();
  const previewTrigger = useRef<HTMLElement | null>(null);
  const [profileDraft, setProfileDraft] = useState({
    id: "",
    label: "",
    githubHost: "github.com",
    ghAccount: "",
    workspaceRoot: "",
  });
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
    const compatibleDashboard =
      loadedInbox === undefined
        ? isDashboard(dashboardPayload)
          ? dashboardPayload
          : undefined
        : dashboardFromInbox(loadedInbox);
    if (compatibleDashboard !== undefined) {
      if (loadedInbox !== undefined) {
        setInbox(loadedInbox);
        setInboxRefreshFailed(false);
      }
      setDashboard(compatibleDashboard);
      activeInboxProfileId.current = compatibleDashboard.profile.id;
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
  const refreshInbox = useCallback(async (): Promise<"success" | "failure"> => {
    const profileId = activeInboxProfileId.current;
    if (profileId === undefined) return "failure";
    const generation = ++inboxRefreshGeneration.current;
    setInboxRefreshing(true);
    setInboxPaused(false);
    try {
      const payload = await api("/v1/inbox");
      const refreshed = parseInboxResponse(payload);
      if (refreshed === undefined || refreshed.profile.id !== profileId)
        throw new Error("Invalid inbox refresh response");
      if (generation !== inboxRefreshGeneration.current) return "success";
      const nextDashboard = dashboardFromInbox(refreshed);
      setInbox(refreshed);
      setDashboard(nextDashboard);
      setInboxRefreshFailed(false);
      setState(screenStateForDashboard(nextDashboard));
      return "success";
    } catch {
      if (generation === inboxRefreshGeneration.current)
        setInboxRefreshFailed(true);
      return "failure";
    } finally {
      if (generation === inboxRefreshGeneration.current)
        setInboxRefreshing(false);
    }
  }, []);
  useEffect(() => {
    if (!fixtureMode) void load();
  }, [fixtureMode]);
  useEffect(() => {
    if (
      fixtureMode ||
      destination.kind !== "dashboard" ||
      dashboard === undefined
    )
      return;
    const scheduler = new InboxRefreshScheduler(refreshInbox);
    inboxRefreshScheduler.current = scheduler;
    const visible = document.visibilityState !== "hidden";
    setInboxPaused(!visible);
    if (visible) {
      if (inboxSchedulerInitialized.current) scheduler.activate();
      else {
        inboxSchedulerInitialized.current = true;
        scheduler.activateAfterSuccessfulResponse();
      }
    }

    const foreground = (): void => {
      if (document.visibilityState === "hidden") return;
      setInboxPaused(false);
      scheduler.setForeground(true);
    };
    const background = (): void => {
      setInboxPaused(true);
      scheduler.setForeground(false);
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") background();
      else foreground();
    };
    window.addEventListener("focus", foreground);
    window.addEventListener("blur", background);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      scheduler.deactivate();
      if (inboxRefreshScheduler.current === scheduler)
        inboxRefreshScheduler.current = undefined;
      window.removeEventListener("focus", foreground);
      window.removeEventListener("blur", background);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      setInboxPaused(true);
    };
  }, [dashboard?.profile.id, destination.kind, fixtureMode, refreshInbox]);
  useEffect(() => {
    if (
      (destination.kind !== "drafts" && destination.kind !== "history") ||
      dashboard === undefined
    )
      return;
    void loadReviewRecords(dashboard.profile.id);
  }, [dashboard, destination.kind, loadReviewRecords]);
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
        activeReviewCount={
          inbox?.inbox.rows.filter((row) => row.categories.includes("running"))
            .length ?? 0
        }
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
                      {outcome === "no_open_prs" ? null : (
                        <Badge
                          variant={
                            outcome === "ready" ? "secondary" : "outline"
                          }
                          className="shrink-0"
                        >
                          {outcome.replaceAll("_", " ")}
                        </Badge>
                      )}
                    </div>
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

  if (fixtureMode)
    return shell(
      <AppFixtureContent
        hash={fixtureHash}
        onNavigationStateChange={setNavigationState}
      />,
      fixtureDestination(fixtureHash),
    );

  if (workbench?.state === "review_started") {
    return shell(
      <PreparedReviewFlow
        workbench={workbench as never}
        {...(destination.kind === "workbench" &&
        (destination.initialSection === "diff" ||
          destination.initialSection === "checks")
          ? { initialSection: destination.initialSection }
          : {})}
        onNavigate={(initialSection) =>
          navigate({
            kind: "workbench",
            sessionId: workbench.session.id,
            initialSection,
          })
        }
        onWorkbenchPatch={(patch) =>
          setWorkbench((current) =>
            current === undefined ? current : { ...current, ...patch },
          )
        }
        onWorkbenchReplace={(next) => setWorkbench(next as WorkbenchPayload)}
        onRefresh={() =>
          openPullRequest(
            {
              host: workbench.session.key.host,
              owner: workbench.session.key.owner,
              repo: workbench.session.key.repo,
              number: workbench.session.key.prNumber,
            },
            "full",
          )
        }
      />,
      { kind: "workbench", sessionId: workbench.session.id },
    );
  }

  if (workbench?.state === "completed" && dashboard !== undefined) {
    return shell(
      <CompletedReviewFlow
        workbench={workbench as never}
        onWorkbenchPatch={(patch) =>
          setWorkbench((current) =>
            current === undefined
              ? current
              : { ...current, ...(patch as Partial<WorkbenchPayload>) },
          )
        }
        onNavigationStateChange={setNavigationState}
      />,
      { kind: "workbench", sessionId: workbench.session.id },
    );
  }

  const select = async (id: string): Promise<void> => {
    const selected = profiles.find((profile) => profile.id === id);
    if (selected !== undefined) {
      // Prevent an older profile's read-only response from replacing the newly
      // selected profile while its own inbox request is still in transit.
      activeInboxProfileId.current = selected.id;
      inboxRefreshGeneration.current += 1;
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
    const scheduler = inboxRefreshScheduler.current;
    if (scheduler !== undefined) {
      await scheduler.refreshManual();
      return;
    }
    await load();
  };
  const refreshRepo = async (repo: Repo): Promise<void> => {
    const refreshed = await api("/v1/dashboard/refresh/repository", {
      method: "POST",
      body: repo,
    });
    if (!isDashboardList(refreshed)) return;
    setDashboard((current) => {
      if (current === undefined) return current;
      return {
        ...current,
        dashboard: mergeDashboardRepository(current.dashboard, refreshed, repo),
      };
    });
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
    setDiscoveryFeedback("Discovering repositories...");
    try {
      const value = await api("/v1/watchlist/suggestions");
      const discovered = Array.isArray(value) ? value.filter(isRepo) : [];
      setSuggestions(discovered);
      setDiscoveryFeedback(
        discovered.length === 0
          ? "No new repositories found in the configured workspace roots."
          : `Found ${discovered.length} new ${discovered.length === 1 ? "repository" : "repositories"}.`,
      );
    } catch {
      setSuggestions([]);
      setDiscoveryFeedback(
        "Could not discover repositories. Check the workspace root in Settings.",
      );
    }
  };
  const addSuggestion = async (repo: Repo): Promise<void> => {
    await api("/v1/watchlist", { method: "POST", body: repo });
    setSuggestions((current) =>
      current.filter((item) => key(item) !== key(repo)),
    );
    await load();
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
    initialSection?: ReviewInitialSection,
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
          host:
            pr.host ?? dashboard?.profile.githubHost ?? profileDraft.githubHost,
          owner: pr.owner,
          repo: pr.repo,
          number: pr.number,
          mode,
          ...(baseSessionId === undefined ? {} : { baseSessionId }),
        },
      });
      if (!isWorkbenchPayload(value))
        throw new Error("invalid workbench projection");
      setOpenedPr(`${pr.owner}/${pr.repo}#${pr.number}`);
      setWorkbench(value);
      navigate({
        kind: "workbench",
        sessionId: value.session.id,
        ...(initialSection === undefined ? {} : { initialSection }),
      });
    } catch {
      setOpenError(`Could not prepare ${pr.owner}/${pr.repo}#${pr.number}.`);
    }
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
  return shell(
    <div
      className={
        destination.kind === "dashboard" || destination.kind === "workbench"
          ? "flex min-h-0 flex-1 flex-col"
          : "p-3 min-[1280px]:p-4"
      }
    >
      {destination.kind === "dashboard" || destination.kind === "workbench" ? (
        inbox !== undefined && dashboard !== undefined ? (
          <InboxScreen
            state={state}
            inbox={inbox}
            dashboard={dashboard}
            refreshStatus={inboxFreshnessLabel({
              ...(inbox.inbox.snapshot?.state === undefined
                ? {}
                : { remote: inbox.inbox.snapshot.state }),
              refreshing: inboxRefreshing,
              paused: inboxPaused,
              refreshFailed: inboxRefreshFailed,
              ...(inbox.inbox.snapshot?.refreshedAt === undefined
                ? {}
                : { refreshedAt: inbox.inbox.snapshot.refreshedAt }),
            })}
            reference={reference}
            onReference={setReference}
            onPreview={() => void previewEntry()}
            onRefresh={() => void refreshDashboard()}
            onSettings={() => navigate({ kind: "settings" })}
            onOpenReview={(row, mode, initialSection) =>
              void openPullRequest(
                row.identity,
                mode,
                initialSection,
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
        <SettingsFlow
          {...(dashboard === undefined ? {} : { dashboard })}
          paths={paths}
          setPaths={setPaths}
          newRepo={newRepo}
          setNewRepo={setNewRepo}
          profileDraft={profileDraft}
          setProfileDraft={setProfileDraft}
          appearance={appearance}
          onAppearanceChange={(next) => {
            setAppearance(next);
            saveAppearancePreference(next);
          }}
          diffThemePreferences={diffThemePreferences}
          onDiffThemeChange={(next) => {
            const saved = saveDiffThemePreferences(next);
            if (saved.saved) setDiffThemePreferences(saved.preferences);
          }}
          suggestions={suggestions}
          discoveryFeedback={discoveryFeedback}
          profiles={profiles}
          {...(pathFeedback === undefined ? {} : { pathFeedback })}
          onAdd={() => void addRepo()}
          onSaveProfile={() => void saveProfile()}
          onDiscover={() => void discover()}
          onAddSuggestion={(repo) => void addSuggestion(repo)}
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
            initialFocus={() => document.getElementById("keep-current-profile")}
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
                id="keep-current-profile"
                autoFocus
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

function screenStateForDashboard(dashboard: Dashboard): DashboardScreenState {
  const outcomes = dashboard.dashboard.repos.map((item) => item.state);
  if (outcomes.includes("github_auth") || outcomes.includes("github_read"))
    return "error";
  if (outcomes.includes("archived")) return "archived";
  if (outcomes.includes("no_open_prs") && dashboard.dashboard.rows.length === 0)
    return "no_open_prs";
  if (outcomes.includes("missing_local_path")) return "degraded";
  return dashboard.dashboard.rows.length === 0 ? "empty" : "success";
}

function isDashboardList(value: unknown): value is Dashboard["dashboard"] {
  return (
    record(value) && Array.isArray(value.rows) && Array.isArray(value.repos)
  );
}

function mergeDashboardRepository(
  current: Dashboard["dashboard"],
  refreshed: Dashboard["dashboard"],
  target: Repo,
): Dashboard["dashboard"] {
  const sameRepository = (repo: Repo): boolean =>
    repo.host === target.host &&
    repo.owner === target.owner &&
    repo.repo === target.repo;
  return {
    rows: [
      ...current.rows.filter(
        (row) =>
          row.summary.ref.owner !== target.owner ||
          row.summary.ref.repo !== target.repo,
      ),
      ...refreshed.rows,
    ],
    repos: [
      ...current.repos.filter((outcome) => !sameRepository(outcome.repo)),
      ...refreshed.repos,
    ],
  };
}
function isWorkbenchPayload(value: unknown): value is WorkbenchPayload {
  // The main process always emits the strict renderer-safe projection; there
  // is no legacy fallback shape at this boundary.
  return parseWorkbenchResponse(value) !== undefined;
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
