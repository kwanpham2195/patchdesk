import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "./components/app-shell";
import { ReviewWorkbenchFlow } from "./flows/review-workbench-flow";
import { AppFixtureContent } from "./flows/app-fixtures";
import { fixtureDestination, isFixtureHash } from "./flows/fixture-routes";
import { InboxFlow } from "./flows/inbox-flow";
import { SettingsModal } from "./components/settings-modal";
import type {
  Dashboard,
  DashboardScreenState,
  Profile,
  Repo,
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
import { TooltipProvider } from "./components/ui/tooltip";
import type { AppDestination } from "./routes";
import { destinationKey, parseDestination } from "./routes";
import { PatchdeskApiError, requestJson } from "./api-client";
import { parseInboxResponse, type InboxResponse } from "./renderer-contracts";
import {
  InboxRefreshScheduler,
  inboxFreshnessLabel,
} from "./inbox-refresh-scheduler";
import {
  applyAppearance,
  clearAppearancePreference,
  loadAppearancePreference,
  type AppearancePreference,
} from "./appearance-preferences";
import {
  applyDiffThemePreferences,
  clearDiffThemePreferences,
  loadDiffThemePreferences,
  parseDiffThemePreferences,
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
  const [workbench, setWorkbench] = useState<WorkbenchPayload | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsOpener, setSettingsOpener] = useState<HTMLElement | undefined>();
  const [appearance, setAppearance] = useState<AppearancePreference>(() =>
    loadAppearancePreference(),
  );
  const [diffThemePreferences, setDiffThemePreferences] =
    useState<DiffThemePreferences>(() => loadDiffThemePreferences());
  const [preferenceError, setPreferenceError] = useState<string>();
  const preferenceRetry = useRef<(() => Promise<void>) | undefined>(undefined);

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
  useEffect(() => {
    applyDiffThemePreferences(diffThemePreferences);
  }, [diffThemePreferences]);
  useEffect(() => {
    if (fixtureMode || typeof window.patchdesk?.request !== "function")
      return;
    let active = true;
    const loadGlobalPreferences = async (): Promise<void> => {
      let stored: GlobalSettings;
      try {
        stored = parseGlobalSettings(await api("/v1/settings"));
      } catch {
        return;
      }
      const appearanceFromStorage = stored.appearance;
      const diffThemeFromStorage = stored.diffTheme;
      const migratedAppearance = appearanceFromStorage === undefined;
      const migratedDiffTheme = diffThemeFromStorage === undefined;
      const nextAppearance = appearanceFromStorage ?? loadAppearancePreference();
      const nextDiffTheme = diffThemeFromStorage === undefined
        ? loadDiffThemePreferences()
        : parseDiffThemePreferences(diffThemeFromStorage);
      const correctedDiffTheme = diffThemeFromStorage !== undefined &&
        !sameDiffTheme(diffThemeFromStorage, nextDiffTheme);

      if (!active) return;
      if (appearanceFromStorage !== undefined) setAppearance(nextAppearance);
      if (diffThemeFromStorage !== undefined) setDiffThemePreferences(nextDiffTheme);

      if (!migratedAppearance && !migratedDiffTheme && !correctedDiffTheme)
        return;
      const patch: GlobalSettingsPatch = {
        ...(migratedAppearance ? { appearance: nextAppearance } : {}),
        ...(migratedDiffTheme || correctedDiffTheme
          ? { diffTheme: nextDiffTheme }
          : {}),
      };
      try {
        await api("/v1/settings", { method: "PATCH", body: patch });
      } catch {
        return;
      }
      if (!active) return;
      if (migratedAppearance) clearAppearancePreference();
      if (migratedDiffTheme) clearDiffThemePreferences();
    };
    void loadGlobalPreferences();
    return () => {
      active = false;
    };
  }, [fixtureMode]);
  const activeInboxProfileId = useRef<string | undefined>(undefined);
  const workspaceGeneration = useRef(0);
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
  const loadWorkspace = useCallback(async (): Promise<void> => {
    const generation = ++workspaceGeneration.current;
    inboxRefreshGeneration.current += 1;
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
        if (!(error instanceof PatchdeskApiError) || error.status !== 404)
          throw error;
        dashboardPayload = await api("/v1/dashboard");
      }
    } catch {
      if (generation === workspaceGeneration.current) setState("error");
      return;
    }
    if (generation !== workspaceGeneration.current) return;
    if (Array.isArray(profilePayload)) setProfiles(profilePayload.filter(isProfile));
    const loadedInbox = parseInboxResponse(dashboardPayload);
    const compatibleDashboard = loadedInbox === undefined
      ? isDashboard(dashboardPayload) ? dashboardPayload : undefined
      : dashboardFromInbox(loadedInbox);
    if (compatibleDashboard === undefined) {
      if (initialState === undefined) setState("empty");
      return;
    }
    if (loadedInbox !== undefined) {
      setInbox(loadedInbox);
      setInboxRefreshFailed(false);
    }
    setDashboard(compatibleDashboard);
    activeInboxProfileId.current = compatibleDashboard.profile.id;
    setState(screenStateForDashboard(compatibleDashboard));
  }, [initialState]);
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
    if (!fixtureMode) void loadWorkspace();
  }, [fixtureMode, loadWorkspace]);
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
    if (fixtureMode) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        if (navigationState === "clear") {
          setSettingsOpener(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
          setSettingsOpen(true);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fixtureMode, navigationState]);
  useEffect(() => {
    if (fixtureMode || typeof window.patchdesk?.request !== "function") return;
    void window.patchdesk
      .request({ operation: "setNavigationState", state: navigationState })
      .catch(() => undefined);
  }, [fixtureMode, navigationState]);

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
  const openSettings = useCallback((opener?: HTMLElement): void => {
    if (navigationState !== "clear") return;
    const fallback = document.querySelector<HTMLElement>("[data-settings-opener]") ?? document.querySelector<HTMLElement>("#main-content");
    setSettingsOpener(opener ?? fallback ?? undefined);
    setSettingsOpen(true);
  }, [navigationState]);
  useEffect(() => {
    if (fixtureMode || typeof window.patchdesk?.onNavigate !== "function")
      return;
    return window.patchdesk.onNavigate((next) => {
      if (next === "settings") openSettings();
    });
  }, [fixtureMode, openSettings]);

  const refreshDashboard = async (): Promise<void> => {
    const scheduler = inboxRefreshScheduler.current;
    if (scheduler !== undefined) {
      await scheduler.refreshManual();
      return;
    }
    await loadWorkspace();
  };
  const updateAppearance = useCallback(async (next: AppearancePreference): Promise<void> => {
    preferenceRetry.current = async () => updateAppearance(next);
    setAppearance(next);
    setPreferenceError(undefined);
    try {
      const stored = parseGlobalSettings(
        await api("/v1/settings", { method: "PATCH", body: { appearance: next } }),
      );
      if (stored.appearance !== undefined) setAppearance(stored.appearance);
    } catch {
      setPreferenceError("Could not save appearance. The visible change is active; retry to persist it.");
    }
  }, []);
  const updateDiffTheme = useCallback(async (next: DiffThemePreferences): Promise<void> => {
    preferenceRetry.current = async () => updateDiffTheme(next);
    setDiffThemePreferences(next);
    setPreferenceError(undefined);
    try {
      const stored = parseGlobalSettings(
        await api("/v1/settings", { method: "PATCH", body: { diffTheme: next } }),
      );
      if (stored.diffTheme !== undefined)
        setDiffThemePreferences(parseDiffThemePreferences(stored.diffTheme));
    } catch {
      setPreferenceError("Could not save diff theme. The visible change is active; retry to persist it.");
    }
  }, []);
  const retryPreferences = useCallback((): void => {
    void preferenceRetry.current?.();
  }, []);

  const shell = (
    content: React.ReactNode,
    next: AppDestination = destination,
  ): React.JSX.Element => (
    <TooltipProvider>
      <AppShell
        destination={next}
        navigationBlocked={navigationState !== "clear"}
        onNavigate={navigate}
        onOpenSettings={openSettings}
      >
        {content}
      </AppShell>
      <SettingsModal
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) setSettingsOpener(undefined);
        }}
        opener={settingsOpener}
        {...(dashboard === undefined ? {} : { dashboard })}
        appearance={appearance}
        onAppearanceChange={(next) => { void updateAppearance(next); }}
        diffThemePreferences={diffThemePreferences}
        onDiffThemeChange={(next) => { void updateDiffTheme(next); }}
        profiles={profiles}
        onWorkspaceReload={loadWorkspace}
        onCleanupSuccess={(action) => {
          if (action === "local") performNavigation({ kind: "dashboard" });
        }}
        onProfileSwitchStart={() => {
          setWorkbench(undefined);
          setDashboard(undefined);
          setInbox(undefined);
          activeInboxProfileId.current = undefined;
          inboxRefreshGeneration.current += 1;
          setInboxRefreshFailed(false);
          setState("loading");
          setDestination({ kind: "dashboard" });
          window.localStorage.setItem("patchdesk.destination", "dashboard");
        }}
        preferenceError={preferenceError}
        onRetryPreferences={retryPreferences}
        onRepositoryRefresh={(value, repo) => {
          if (!isDashboardList(value)) return;
          setDashboard((current) => current === undefined ? current : { ...current, dashboard: mergeDashboardRepository(current.dashboard, value, repo) });
        }}
      />
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

  if (workbench?.state === "review") {
    return shell(
      <ReviewWorkbenchFlow
        workbench={workbench}
        {...(destination.kind === "workbench" &&
        (destination.initialSection === "diff" || destination.initialSection === "checks")
          ? { initialSection: destination.initialSection }
          : {})}
        onNavigate={(initialSection) =>
          navigate({
            kind: "workbench",
            reviewId: workbench.review.id,
            initialSection,
          })
        }
        onWorkbenchPatch={(patch) =>
          setWorkbench((current) =>
            current === undefined ? current : { ...current, ...patch },
          )
        }
        onWorkbenchReplace={(next) => setWorkbench(next)}
        onNavigationStateChange={setNavigationState}
      />,
      { kind: "workbench", reviewId: workbench.review.id },
    );
  }

  return shell(
    <div className="flex min-h-0 flex-1 flex-col">
      <InboxFlow
          destination={destination.kind}
          {...(destination.kind === "workbench" ? { reviewId: destination.reviewId } : {})}
          {...(dashboard === undefined ? {} : { dashboard })}
          {...(inbox === undefined ? {} : { inbox })}
          state={state}
          refreshStatus={inboxFreshnessLabel({
            ...(inbox?.inbox.snapshot?.state === undefined ? {} : { remote: inbox.inbox.snapshot.state }),
            refreshing: inboxRefreshing,
            paused: inboxPaused,
            refreshFailed: inboxRefreshFailed,
            ...(inbox?.inbox.snapshot?.refreshedAt === undefined ? {} : { refreshedAt: inbox.inbox.snapshot.refreshedAt }),
          })}
          onRefresh={() => void refreshDashboard()}
          onSettings={() => openSettings()}
          onWorkspaceReload={loadWorkspace}
          onOpenWorkbench={(next, initialSection) => {
            setWorkbench(next);
            navigate({ kind: "workbench", reviewId: next.review?.id ?? next.session.id, ...(initialSection === undefined ? {} : { initialSection }) });
          }}
        />
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

type GlobalSettings = {
  readonly appearance?: AppearancePreference;
  readonly diffTheme?: unknown;
};

type GlobalSettingsPatch = {
  readonly appearance?: AppearancePreference;
  readonly diffTheme?: DiffThemePreferences;
};

function parseGlobalSettings(value: unknown): GlobalSettings {
  if (!record(value)) return {};
  return {
    ...(value.appearance === "system" || value.appearance === "light" || value.appearance === "dark"
      ? { appearance: value.appearance }
      : {}),
    ...(Object.hasOwn(value, "diffTheme") ? { diffTheme: value.diffTheme } : {}),
  };
}

function sameDiffTheme(value: unknown, expected: DiffThemePreferences): boolean {
  return record(value) &&
    value.light === expected.light &&
    value.dark === expected.dark;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isProfile(value: unknown): value is Profile {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    typeof value.githubHost === "string" &&
    typeof value.ghAccount === "string" &&
    (value.workspaceRoots === undefined || stringArray(value.workspaceRoots)) &&
    (value.ownerFilters === undefined || stringArray(value.ownerFilters)) &&
    (value.rulePaths === undefined || stringArray(value.rulePaths))
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
      ...(inbox.profile.ownerFilters === undefined
        ? {}
        : { ownerFilters: inbox.profile.ownerFilters }),
      ...(inbox.profile.rulePaths === undefined
        ? {}
        : { rulePaths: inbox.profile.rulePaths }),
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

function isDashboardList(value: unknown): value is Dashboard["dashboard"] {
  return record(value) && Array.isArray(value.rows) && Array.isArray(value.repos);
}

function mergeDashboardRepository(
  current: Dashboard["dashboard"],
  refreshed: Dashboard["dashboard"],
  target: Repo,
): Dashboard["dashboard"] {
  const sameRepository = (repo: Repo): boolean => repo.host === target.host && repo.owner === target.owner && repo.repo === target.repo;
  return {
    rows: [...current.rows.filter((row) => row.summary.ref.owner !== target.owner || row.summary.ref.repo !== target.repo), ...refreshed.rows],
    repos: [...current.repos.filter((outcome) => !sameRepository(outcome.repo)), ...refreshed.repos],
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
