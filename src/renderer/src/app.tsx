import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppShell } from "./components/app-shell";
import { fixtureDestination, isFixtureHash } from "./flows/fixture-routes";
import { InboxFlow } from "./flows/inbox-flow";
import { SettingsModal } from "./components/settings-modal";
import type {
  Dashboard,
  DashboardScreenState,
  Profile,
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
import {
  clearSettingsRestore,
  loadSettingsRestore,
  loadWorkbenchUiState,
  saveSettingsRestore,
  saveWorkbenchUiState,
} from "./lib/screen-restore";
import type { ReviewWorkbenchInitialState } from "./components/review-workbench";
import type { ReviewWorkbenchFlowProps } from "./flows/review-workbench-flow";
import type { SettingsSection } from "./flows/settings-flow";
import { requestJson } from "./api-client";
import {
  parseInboxResponse,
  type InboxResponse,
  type WorkbenchResponse,
} from "./renderer-contracts";
import {
  InboxRefreshScheduler,
  inboxFreshnessLabel,
  type InboxRefreshOutcome,
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

type NavigationState = "clear" | "dirty_draft" | "write_pending";
type ReviewWorkbenchFlowComponent =
  React.ComponentType<ReviewWorkbenchFlowProps>;
type FixtureContentComponent = React.ComponentType<{
  readonly hash: string;
  readonly onNavigationStateChange: (state: NavigationState) => void;
}>;
type PerformanceFixtureComponent = React.ComponentType;
type RouteLoadBoundaryProps = {
  readonly children: ReactNode;
  readonly onRetry: () => void;
};

type WorkspaceState = {
  readonly profiles: ReadonlyArray<Profile>;
  readonly dashboard?: Dashboard;
  readonly inbox?: InboxResponse;
  readonly screen: DashboardScreenState;
  readonly refreshing: boolean;
  readonly refreshFailed: boolean;
};

type WorkspaceAction =
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed"; readonly screen: DashboardScreenState }
  | {
      readonly _tag: "loaded";
      readonly profiles: ReadonlyArray<Profile>;
      readonly inbox: InboxResponse;
      readonly dashboard: Dashboard;
      readonly screen: DashboardScreenState;
    }
  | { readonly _tag: "refreshStarted" }
  | {
      readonly _tag: "refreshSucceeded";
      readonly inbox: InboxResponse;
      readonly dashboard: Dashboard;
      readonly screen: DashboardScreenState;
    }
  | { readonly _tag: "refreshFailed" }
  | { readonly _tag: "refreshFinished" }
  | { readonly _tag: "cleared" };

function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action._tag) {
    case "loading":
      return { ...state, screen: "loading" };
    case "failed":
      return { ...state, screen: action.screen };
    case "loaded":
      return {
        ...state,
        profiles: action.profiles,
        inbox: action.inbox,
        dashboard: action.dashboard,
        screen: action.screen,
        refreshFailed: false,
      };
    case "refreshStarted":
      return { ...state, refreshing: true, refreshFailed: false };
    case "refreshSucceeded":
      return {
        ...state,
        inbox: action.inbox,
        dashboard: action.dashboard,
        screen: action.screen,
        refreshFailed: false,
      };
    case "refreshFailed":
      return { ...state, refreshFailed: true };
    case "refreshFinished":
      return { ...state, refreshing: false };
    case "cleared":
      return {
        profiles: state.profiles,
        refreshing: state.refreshing,
        refreshFailed: false,
        screen: "loading",
      };
  }
}

export type ReviewWorkbenchLoader = () => Promise<{
  readonly default: ReviewWorkbenchFlowComponent;
}>;
export type FixtureContentLoader = () => Promise<{
  readonly default: FixtureContentComponent;
}>;
export type PerformanceFixtureLoader = () => Promise<{
  readonly default: PerformanceFixtureComponent;
}>;

const loadReviewWorkbench: ReviewWorkbenchLoader = async () => ({
  default: (await import("./flows/review-workbench-flow")).ReviewWorkbenchFlow,
});
const loadFixtureContent: FixtureContentLoader = async () => ({
  default: (await import("./flows/app-fixtures")).AppFixtureContent,
});
const loadPerformanceFixture: PerformanceFixtureLoader = async () => ({
  default: (await import("./flows/performance-fixture")).PerformanceFixture,
});

export type AppProps = {
  readonly initialState?: DashboardScreenState;
  /** Loads the Review route only after Patchdesk has a canonical Review projection. */
  readonly reviewWorkbenchLoader?: ReviewWorkbenchLoader;
  /** Loads browser fixture-only code only for a recognized fixture hash. */
  readonly fixtureContentLoader?: FixtureContentLoader;
  /** Loads the performance fixture without the broader fixture route graph. */
  readonly performanceFixtureLoader?: PerformanceFixtureLoader;
};

/** Renderer-only dashboard: every product value is loaded from the authenticated local API. */
// Pre-existing giant component (~800 lines before this change;
// `react-doctor --scope changed --base 55748e8` reports zero new issues here).
// Splitting it is the renderer god-file refactor the project's own plans
// explicitly defer to dedicated, separately-scoped work, not a fix this
// small feature change should take on.
// react-doctor-disable-next-line react-doctor/no-giant-component -- see comment above
export function App({
  initialState,
  reviewWorkbenchLoader = loadReviewWorkbench,
  fixtureContentLoader = loadFixtureContent,
  performanceFixtureLoader = loadPerformanceFixture,
}: AppProps): React.JSX.Element {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- detects a non-browser (SSR/test) runtime, not external input to decode; there is no schema for "does the global window exist".
  const fixtureHash = typeof window === "undefined" ? "" : window.location.hash;
  const fixtureMode = isFixtureHash(fixtureHash);
  const [reviewLoaderGeneration, setReviewLoaderGeneration] = useState(0);
  const LazyReviewWorkbench = useMemo(
    () => lazy(reviewWorkbenchLoader),
    [reviewWorkbenchLoader, reviewLoaderGeneration],
  );
  const LazyFixtureContent = useMemo(
    () => lazy(fixtureContentLoader),
    [fixtureContentLoader],
  );
  const LazyPerformanceFixture = useMemo(
    () => lazy(performanceFixtureLoader),
    [performanceFixtureLoader],
  );
  const [destination, setDestination] = useState<AppDestination>(() =>
    parseDestination(
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- detects a non-browser (SSR/test) runtime, not external input to decode; parseDestination is the actual boundary parser for the stored value.
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem("patchdesk.destination"),
    ),
  );
  const [workspace, dispatchWorkspace] = useReducer(workspaceReducer, {
    profiles: [],
    screen: initialState ?? "loading",
    refreshing: false,
    refreshFailed: false,
  });
  const {
    profiles,
    dashboard,
    inbox,
    screen: state,
    refreshing: inboxRefreshing,
    refreshFailed: inboxRefreshFailed,
  } = workspace;
  const [inboxPaused, setInboxPaused] = useState(false);
  const [workbench, setWorkbench] = useState<WorkbenchPayload | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsOpener, setSettingsOpener] = useState<
    HTMLElement | undefined
  >();
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(
    () => restoredSettingsSection() ?? "general",
  );
  // Workbench position restored after reload; applied once to the matching review.
  const restoredWorkbenchUi = useRef<
    | { readonly reviewId: string; readonly state: ReviewWorkbenchInitialState }
    | undefined
  >(undefined);
  useEffect(() => {
    if (
      fixtureMode ||
      destination.kind !== "workbench" ||
      restoredWorkbenchUi.current !== undefined
    )
      return;
    const state = loadWorkbenchUiState(destination.reviewId);
    if (state !== undefined) {
      restoredWorkbenchUi.current = { reviewId: destination.reviewId, state };
    }
  }, [destination, fixtureMode]);
  useEffect(() => {
    if (fixtureMode || workbench === undefined) return;
    restoredWorkbenchUi.current = undefined;
  }, [fixtureMode, workbench]);
  // A reload with Settings open reopens the overlay on the same section.
  useEffect(() => {
    if (fixtureMode || settingsOpen || loadSettingsRestore() === undefined)
      return;
    setSettingsOpen(true);
  }, [fixtureMode, settingsOpen]);
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
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- detects browser capability support, not external input to decode; there is no schema for "does matchMedia exist".
    if (typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [appearance]);
  useEffect(() => {
    applyDiffThemePreferences(diffThemePreferences);
  }, [diffThemePreferences]);
  useEffect(() => {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- detects desktop-bridge capability support, not external input to decode; there is no schema for "is window.patchdesk.request present".
    if (fixtureMode || typeof window.patchdesk?.request !== "function") return;
    let active = true;
    const loadGlobalPreferences = async (): Promise<void> => {
      preferenceRetry.current = loadGlobalPreferences;
      if (active) setPreferenceError(undefined);
      let stored: GlobalSettings;
      try {
        stored = parseGlobalSettings(await api("/v1/settings"));
      } catch {
        // A missing config file is a genuine first run and is already
        // normalized to an empty settings object upstream, so any rejection
        // here is a real load failure (corrupt file, I/O error, ...).
        if (active)
          setPreferenceError(
            "Could not load saved preferences. Appearance and diff theme are using defaults; retry to reload the saved settings, or change a preference to overwrite the stored file.",
          );
        return;
      }
      const appearanceFromStorage = stored.appearance;
      const diffThemeFromStorage = stored.diffTheme;
      const migratedAppearance = appearanceFromStorage === undefined;
      const migratedDiffTheme = diffThemeFromStorage === undefined;
      const nextAppearance =
        appearanceFromStorage ?? loadAppearancePreference();
      const nextDiffTheme =
        diffThemeFromStorage === undefined
          ? loadDiffThemePreferences()
          : parseDiffThemePreferences(diffThemeFromStorage);
      const correctedDiffTheme =
        diffThemeFromStorage !== undefined &&
        !sameDiffTheme(diffThemeFromStorage, nextDiffTheme);

      if (!active) return;
      if (appearanceFromStorage !== undefined) setAppearance(nextAppearance);
      if (diffThemeFromStorage !== undefined)
        setDiffThemePreferences(nextDiffTheme);

      if (!migratedAppearance && !migratedDiffTheme && !correctedDiffTheme)
        return;
      const appearanceField = migratedAppearance
        ? { appearance: nextAppearance }
        : {};
      const diffThemeField =
        migratedDiffTheme || correctedDiffTheme
          ? { diffTheme: nextDiffTheme }
          : {};
      const patch: GlobalSettingsPatch = {
        ...appearanceField,
        ...diffThemeField,
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
  const [navigationState, setNavigationState] =
    useState<NavigationState>("clear");
  const [pendingDestination, setPendingDestination] =
    useState<AppDestination>();
  const loadWorkspace = useCallback(async (): Promise<void> => {
    const generation = ++workspaceGeneration.current;
    inboxRefreshGeneration.current += 1;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- detects a non-browser (SSR/test) runtime, not external input to decode; there is no schema for "does the global window exist".
    if (typeof window === "undefined" || !("patchdesk" in window)) {
      dispatchWorkspace({ _tag: "failed", screen: initialState ?? "empty" });
      return;
    }
    dispatchWorkspace({ _tag: "loading" });
    let profilePayload: unknown;
    let inboxPayload: unknown;
    try {
      profilePayload = await api("/v1/profiles");
      inboxPayload = await api("/v1/inbox");
    } catch {
      if (generation === workspaceGeneration.current)
        dispatchWorkspace({ _tag: "failed", screen: "error" });
      return;
    }
    if (generation !== workspaceGeneration.current) return;
    const nextProfiles = Array.isArray(profilePayload)
      ? profilePayload.filter(isProfile)
      : [];
    const loadedInbox = parseInboxResponse(inboxPayload);
    if (loadedInbox === undefined) {
      if (initialState === undefined)
        dispatchWorkspace({ _tag: "failed", screen: "empty" });
      return;
    }
    const currentDashboard = dashboardFromInbox(loadedInbox);
    dispatchWorkspace({
      _tag: "loaded",
      profiles: nextProfiles,
      inbox: loadedInbox,
      dashboard: currentDashboard,
      screen: screenStateForDashboard(currentDashboard),
    });
    activeInboxProfileId.current = currentDashboard.profile.id;
  }, [initialState]);
  const refreshInbox = useCallback(async (): Promise<InboxRefreshOutcome> => {
    const profileId = activeInboxProfileId.current;
    if (profileId === undefined) return "failure";
    const generation = ++inboxRefreshGeneration.current;
    dispatchWorkspace({ _tag: "refreshStarted" });
    setInboxPaused(false);
    try {
      const payload = await api("/v1/inbox");
      const refreshed = parseInboxResponse(payload);
      if (refreshed === undefined || refreshed.profile.id !== profileId)
        throw new Error("Invalid inbox refresh response");
      if (generation !== inboxRefreshGeneration.current) return "success";
      const nextDashboard = dashboardFromInbox(refreshed);
      dispatchWorkspace({
        _tag: "refreshSucceeded",
        inbox: refreshed,
        dashboard: nextDashboard,
        screen: screenStateForDashboard(nextDashboard),
      });
      return allRepositoriesRateLimited(refreshed.inbox.repositories)
        ? { kind: "rate_limited", resumeAt: maxResumeAt(refreshed.inbox.repositories) }
        : "success";
    } catch {
      if (generation === inboxRefreshGeneration.current)
        dispatchWorkspace({ _tag: "refreshFailed" });
      return "failure";
    } finally {
      if (generation === inboxRefreshGeneration.current)
        dispatchWorkspace({ _tag: "refreshFinished" });
    }
  }, []);
  const hasDashboard = dashboard !== undefined;
  useEffect(() => {
    if (!fixtureMode) void loadWorkspace();
  }, [fixtureMode, loadWorkspace]);
  useEffect(() => {
    if (fixtureMode || destination.kind !== "dashboard" || !hasDashboard)
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
  }, [
    dashboard?.profile.id,
    destination.kind,
    fixtureMode,
    hasDashboard,
    refreshInbox,
  ]);
  useEffect(() => {
    if (fixtureMode) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        if (navigationState === "clear") {
          setSettingsOpener(
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : undefined,
          );
          setSettingsOpen(true);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fixtureMode, navigationState]);
  useEffect(() => {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- detects desktop-bridge capability support, not external input to decode; there is no schema for "is window.patchdesk.request present".
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
  const openSettings = useCallback(
    (opener?: HTMLElement, section?: SettingsSection): void => {
      if (navigationState !== "clear") return;
      const fallback =
        document.querySelector<HTMLElement>("[data-settings-opener]") ??
        document.querySelector<HTMLElement>("#main-content");
      setSettingsOpener(opener ?? fallback ?? undefined);
      setSettingsSection(section ?? "general");
      setSettingsOpen(true);
    },
    [navigationState],
  );
  useEffect(() => {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- detects desktop-bridge capability support, not external input to decode; there is no schema for "is window.patchdesk.onNavigate present".
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
  const updateAppearance = useCallback(
    async (next: AppearancePreference): Promise<void> => {
      preferenceRetry.current = async () => updateAppearance(next);
      setAppearance(next);
      setPreferenceError(undefined);
      try {
        const stored = parseGlobalSettings(
          await api("/v1/settings", {
            method: "PATCH",
            body: { appearance: next },
          }),
        );
        if (stored.appearance !== undefined) setAppearance(stored.appearance);
      } catch {
        setPreferenceError(
          "Could not save appearance. The visible change is active; retry to persist it.",
        );
      }
    },
    [],
  );
  const updateDiffTheme = useCallback(
    async (next: DiffThemePreferences): Promise<void> => {
      preferenceRetry.current = async () => updateDiffTheme(next);
      setDiffThemePreferences(next);
      setPreferenceError(undefined);
      try {
        const stored = parseGlobalSettings(
          await api("/v1/settings", {
            method: "PATCH",
            body: { diffTheme: next },
          }),
        );
        if (stored.diffTheme !== undefined)
          setDiffThemePreferences(parseDiffThemePreferences(stored.diffTheme));
      } catch {
        setPreferenceError(
          "Could not save diff theme. The visible change is active; retry to persist it.",
        );
      }
    },
    [],
  );
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
        profiles={profiles.map((p) => ({ id: p.id, label: p.label }))}
        activeProfileId={dashboard?.profile.id ?? inbox?.profile.id ?? ""}
        onProfileSwitch={async (id) => {
          await api("/v1/profiles/select", { method: "POST", body: { id } });
          setWorkbench(undefined);
          dispatchWorkspace({ _tag: "cleared" });
          await loadWorkspace();
        }}
      >
        {content}
      </AppShell>
      <SettingsModal
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) {
            setSettingsOpener(undefined);
            clearSettingsRestore();
          }
        }}
        opener={settingsOpener}
        initialSection={settingsSection}
        onSectionChange={(section) => saveSettingsRestore(section)}
        {...(dashboard === undefined ? {} : { dashboard })}
        appearance={appearance}
        onAppearanceChange={(next) => {
          void updateAppearance(next);
        }}
        diffThemePreferences={diffThemePreferences}
        onDiffThemeChange={(next) => {
          void updateDiffTheme(next);
        }}
        profiles={profiles}
        onWorkspaceReload={loadWorkspace}
        onCleanupSuccess={(action) => {
          if (action === "local") performNavigation({ kind: "dashboard" });
        }}
        onProfileSwitchStart={() => {
          setWorkbench(undefined);
          dispatchWorkspace({ _tag: "cleared" });
          activeInboxProfileId.current = undefined;
          inboxRefreshGeneration.current += 1;
          setDestination({ kind: "dashboard" });
          window.localStorage.setItem("patchdesk.destination", "dashboard");
        }}
        preferenceError={preferenceError}
        onRetryPreferences={retryPreferences}
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
      fixtureHash === "#performance-fixture" ? (
        <Suspense fallback={<RouteLoadingFallback label="Loading fixture" />}>
          <LazyPerformanceFixture />
        </Suspense>
      ) : (
        <Suspense fallback={<RouteLoadingFallback label="Loading fixture" />}>
          <LazyFixtureContent
            hash={fixtureHash}
            onNavigationStateChange={setNavigationState}
          />
        </Suspense>
      ),
      fixtureDestination(fixtureHash),
    );

  if (workbench?.state === "review") {
    return shell(
      <RouteLoadBoundary
        key={`${workbench.review.id}:${reviewLoaderGeneration}`}
        onRetry={() =>
          setReviewLoaderGeneration((generation) => generation + 1)
        }
      >
        <Suspense
          fallback={<RouteLoadingFallback label="Loading review workbench" />}
        >
          <LazyReviewWorkbench
            workbench={workbench}
            {...(destination.kind === "workbench" &&
            (destination.initialSection === "diff" ||
              destination.initialSection === "checks")
              ? { initialSection: destination.initialSection }
              : {})}
            {...(restoredWorkbenchUi.current !== undefined &&
            restoredWorkbenchUi.current.reviewId === workbench.review.id
              ? { initialUiState: restoredWorkbenchUi.current.state }
              : {})}
            onUiStateChange={(state) =>
              saveWorkbenchUiState(workbench.review.id, state)
            }
            onNavigate={(initialSection) =>
              navigate({
                kind: "workbench",
                reviewId: workbench.review.id,
                initialSection,
              })
            }
            onWorkbenchPatch={(patch) =>
              setWorkbench((current) => {
                if (current === undefined) return current;
                const { insights, ...rest } = patch;
                const insightsField =
                  insights === undefined
                    ? {}
                    : {
                        // SAFETY: `insights` is patch's own typed field merged onto
                        // current.insights, so the merged shape still satisfies
                        // WorkbenchResponse["insights"]; the spread alone loses that
                        // because TS widens a merge of two known records to a plain object.
                        insights: {
                          ...current.insights,
                          ...insights,
                        } as WorkbenchResponse["insights"],
                      };
                return { ...current, ...rest, ...insightsField };
              })
            }
            onWorkbenchReplace={(next) => setWorkbench(next)}
            onNavigationStateChange={setNavigationState}
          />
        </Suspense>
      </RouteLoadBoundary>,
      { kind: "workbench", reviewId: workbench.review.id },
    );
  }

  const reviewIdField =
    destination.kind === "workbench"
      ? { reviewId: destination.reviewId }
      : {};
  const dashboardField = dashboard === undefined ? {} : { dashboard };
  const inboxField = inbox === undefined ? {} : { inbox };
  const remoteField =
    inbox?.inbox.snapshot?.state === undefined
      ? {}
      : { remote: inbox.inbox.snapshot.state };
  const refreshedAtField =
    inbox?.inbox.snapshot?.refreshedAt === undefined
      ? {}
      : { refreshedAt: inbox.inbox.snapshot.refreshedAt };
  return shell(
    <div className="flex min-h-0 flex-1 flex-col">
      <InboxFlow
        destination={destination.kind}
        {...reviewIdField}
        {...dashboardField}
        {...inboxField}
        state={state}
        refreshStatus={inboxFreshnessLabel({
          ...remoteField,
          refreshing: inboxRefreshing,
          paused: inboxPaused,
          refreshFailed: inboxRefreshFailed,
          ...refreshedAtField,
        })}
        onRefresh={() => void refreshDashboard()}
        onSettings={(section) => openSettings(undefined, section)}
        onOpenWorkbench={(next, initialSection) => {
          setWorkbench(next);
          const initialSectionField =
            initialSection === undefined ? {} : { initialSection };
          navigate({
            kind: "workbench",
            reviewId: next.review?.id ?? next.session.id,
            ...initialSectionField,
          });
        }}
      />
    </div>,
  );
}

function restoredSettingsSection(): SettingsSection | undefined {
  const restored = loadSettingsRestore();
  if (restored === undefined) return undefined;
  return restored.section === "general" ||
    restored.section === "workspace" ||
    restored.section === "review" ||
    restored.section === "data" ||
    restored.section === "logs"
    ? restored.section
    : undefined;
}

function RouteLoadingFallback({
  label,
}: {
  readonly label: string;
}): React.JSX.Element {
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center p-6"
      role="status"
      aria-live="polite"
    >
      {label}
    </div>
  );
}

type RouteLoadBoundaryState = { readonly error: Error | undefined };

class RouteLoadBoundary extends Component<
  RouteLoadBoundaryProps,
  RouteLoadBoundaryState
> {
  override state: RouteLoadBoundaryState = { error: undefined };

  static getDerivedStateFromError(error: Error): RouteLoadBoundaryState {
    return { error };
  }

  override render(): ReactNode {
    if (this.state.error === undefined) return this.props.children;
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-6"
        role="alert"
      >
        <div className="space-y-3 text-center">
          <p>Patchdesk could not load the Review workbench.</p>
          <button
            type="button"
            className="underline"
            onClick={this.props.onRetry}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
}

async function api(
  path: string,
  init: { readonly method?: string; readonly body?: unknown } = {},
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- this is the renderer's own request boundary; every call site immediately parses the result with a dedicated parser (parseInboxResponse, parseGlobalSettings, isProfile, ...).
): Promise<unknown> {
  // SAFETY: only local callers of `api()` supply `init.method`, always one of these five literals.
  const methodField =
    init.method === undefined
      ? {}
      : { method: init.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE" };
  const bodyField = init.body === undefined ? {} : { body: init.body };
  return await requestJson(path, { ...methodField, ...bodyField });
}

type GlobalSettings = {
  readonly appearance?: AppearancePreference;
  readonly diffTheme?: unknown;
};

type GlobalSettingsPatch = {
  readonly appearance?: AppearancePreference;
  readonly diffTheme?: DiffThemePreferences;
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the GlobalSettings I/O boundary parser for the raw /v1/settings response; there is no earlier boundary to move the parse to.
function parseGlobalSettings(value: unknown): GlobalSettings {
  if (!record(value)) return {};
  const appearance: AppearancePreference | undefined =
    value.appearance === "system" ||
    value.appearance === "light" ||
    value.appearance === "dark"
      ? value.appearance
      : undefined;
  const appearanceField = appearance === undefined ? {} : { appearance };
  const diffThemeField = Object.hasOwn(value, "diffTheme")
    ? { diffTheme: value.diffTheme }
    : {};
  return { ...appearanceField, ...diffThemeField };
}

function sameDiffTheme(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- compares a raw stored diffTheme value (parsed no further than `record()`) against an already-parsed DiffThemePreferences; there is no earlier boundary for the raw side.
  value: unknown,
  expected: DiffThemePreferences,
): boolean {
  return (
    record(value) &&
    value.light === expected.light &&
    value.dark === expected.dark
  );
}
function record(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the foundational "is a plain object" boundary predicate every other parser in this file narrows further; there is no earlier, more specific boundary.
  value: unknown,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- generic "is a plain object" predicate; the point is that field shapes are not yet known, so each caller (isProfile, parseGlobalSettings, ...) narrows specific fields itself immediately after.
): value is Record<string, unknown> {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw external input at this exact I/O boundary predicate; no earlier parser exists for this primitive shape.
  return typeof value === "object" && value !== null;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the string-array I/O boundary parser reused by isProfile below; there is no earlier boundary to move the parse to.
function stringArray(value: unknown): value is ReadonlyArray<string> {
  return (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows raw external array entries at this exact I/O boundary predicate; no earlier parser exists for this primitive shape.
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the Profile I/O boundary parser for the raw /v1/profiles response; there is no earlier boundary to move the parse to.
function isProfile(value: unknown): value is Profile {
  return (
    record(value) &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field at this exact I/O boundary; no earlier parser exists for this primitive shape.
    typeof value.id === "string" &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field at this exact I/O boundary; no earlier parser exists for this primitive shape.
    typeof value.label === "string" &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field at this exact I/O boundary; no earlier parser exists for this primitive shape.
    typeof value.githubHost === "string" &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows a raw JSON field at this exact I/O boundary; no earlier parser exists for this primitive shape.
    typeof value.ghAccount === "string" &&
    (value.workspaceRoots === undefined || stringArray(value.workspaceRoots)) &&
    (value.ownerFilters === undefined || stringArray(value.ownerFilters)) &&
    (value.rulePaths === undefined || stringArray(value.rulePaths))
  );
}
function dashboardFromInbox(inbox: InboxResponse): Dashboard {
  const workspaceRootsField =
    inbox.profile.workspaceRoots === undefined
      ? {}
      : { workspaceRoots: inbox.profile.workspaceRoots };
  const ownerFiltersField =
    inbox.profile.ownerFilters === undefined
      ? {}
      : { ownerFilters: inbox.profile.ownerFilters };
  const rulePathsField =
    inbox.profile.rulePaths === undefined
      ? {}
      : { rulePaths: inbox.profile.rulePaths };
  const reposField =
    inbox.profile.repos === undefined ? {} : { repos: inbox.profile.repos };
  return {
    profile: {
      id: inbox.profile.id,
      label: inbox.profile.label,
      githubHost: inbox.profile.githubHost,
      ghAccount: inbox.profile.ghAccount,
      ...workspaceRootsField,
      ...ownerFiltersField,
      ...rulePathsField,
      ...reposField,
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
      repos: inbox.inbox.repositories.map((outcome) => {
        const resumeAtField =
          outcome.resumeAt === undefined ? {} : { resumeAt: outcome.resumeAt };
        const forbiddenReasonField =
          outcome.forbiddenReason === undefined
            ? {}
            : { forbiddenReason: outcome.forbiddenReason };
        return {
          repo: {
            host: outcome.repo.host,
            owner: outcome.repo.owner,
            repo: outcome.repo.repo,
          },
          state: outcome.state,
          ...resumeAtField,
          ...forbiddenReasonField,
        };
      }),
    },
  };
}

/** True only when every watched repo is rate-limited; a mix with healthy repos keeps the normal poll cadence. */
function allRepositoriesRateLimited(
  repositories: InboxResponse["inbox"]["repositories"],
): boolean {
  return (
    repositories.length > 0 &&
    repositories.every((repo) => repo.state === "github_rate_limited")
  );
}

/** The latest known resume time across all-rate-limited repos, falling back to a conservative 60-minute wait. */
function maxResumeAt(
  repositories: InboxResponse["inbox"]["repositories"],
): string {
  const resumeTimesMs = repositories.reduce<Array<number>>((acc, repo) => {
    const parsed =
      repo.resumeAt === undefined ? NaN : Date.parse(repo.resumeAt);
    if (!Number.isNaN(parsed)) acc.push(parsed);
    return acc;
  }, []);
  return resumeTimesMs.length === 0
    ? new Date(Date.now() + 60 * 60_000).toISOString()
    : new Date(Math.max(...resumeTimesMs)).toISOString();
}

function screenStateForDashboard(dashboard: Dashboard): DashboardScreenState {
  const outcomes = dashboard.dashboard.repos.map((item) => item.state);
  if (
    outcomes.includes("github_auth") ||
    outcomes.includes("github_read") ||
    outcomes.includes("github_rate_limited") ||
    outcomes.includes("github_forbidden")
  )
    return "error";
  if (outcomes.includes("no_open_prs") && dashboard.dashboard.rows.length === 0)
    return "no_open_prs";
  return dashboard.dashboard.rows.length === 0 ? "empty" : "success";
}
