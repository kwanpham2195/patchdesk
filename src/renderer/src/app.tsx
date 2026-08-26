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
import { screenStateForInbox } from "./screen-state-for-inbox";
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
import { BusyProvider } from "./hooks/use-busy";
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
  loadInboxViewPreferences,
  saveInboxViewPreferences,
} from "./inbox-view-preferences";
import {
  DEFAULT_INBOX_PAGE_SIZE,
  type InboxPageSize,
  type InboxStateFilter,
} from "../../domain/maintainer-inbox";
import { inboxFreshnessLabel } from "./inbox-refresh-scheduler";
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
import {
  sameRepositoryIdentity,
  type RepositoryIdentity,
} from "../../domain/repository-identity";

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

type InboxRequestState = {
  /**
   * The Selected repository, sent explicitly once known. Absent only for the
   * renderer's bootstrap request, before the active profile's watchlist is
   * known — the main process resolves the active profile and falls back to
   * its first watched repository in that case. Every other request explicitly
   * sends the repository the picker has selected, resolved by
   * `resolveInboxRepository` from the stored preference and the current
   * watchlist.
   */
  readonly repository?: Repo;
  readonly state: InboxStateFilter;
  readonly pageSize: InboxPageSize;
  /** The label filter, sent as repeated `label` qualifiers.
   * Repository-scoped: `changeInboxRepository` always resets it to `[]`,
   * since a label chosen in one repository may not exist in the next. */
  readonly selectedLabels: ReadonlyArray<string>;
  /** The "Awaiting review from you" preset (ADR 0031), sent as
   * `awaitingMyReview=1`. Unlike `selectedLabels` it is not
   * repository-scoped, so `changeInboxRepository` carries it over. */
  readonly awaitingMyReview: boolean;
  readonly pageToken?: string;
  readonly previousPageTokens: ReadonlyArray<string | undefined>;
};

/**
 * Resolves the Selected repository (the screen's root state, see ADR 0031)
 * from the profile's current watchlist and the last repository stored in
 * preferences: the stored repository if it is still watched, otherwise the
 * first watched repository, or `undefined` when the watchlist is empty.
 */
function resolveInboxRepository(
  watchlist: ReadonlyArray<Repo>,
  stored: RepositoryIdentity | undefined,
): Repo | undefined {
  const kept =
    stored === undefined
      ? undefined
      : watchlist.find((candidate) =>
          sameRepositoryIdentity(candidate, stored),
        );
  return kept ?? watchlist[0];
}

/**
 * Builds the next inbox request from the current one. Each caller states only
 * what it changes; every field it does not name carries over, and the page
 * cursor resets — a cursor minted under a different repository, state, page
 * size, or label filter belongs to a different GitHub search and is rejected
 * as `invalid_page`, so carrying one forward could only produce a failed
 * read. The two paging callers are the exception and name `pageToken` and
 * `previousPageTokens` themselves.
 *
 * `repository` is honoured by key presence rather than by value: passing
 * `{ repository: undefined }` clears it, which the bootstrap request and an
 * emptied watchlist both need, while omitting the key keeps the current one.
 */
function nextInboxRequest(
  current: InboxRequestState,
  overrides: {
    readonly repository?: Repo | undefined;
    readonly state?: InboxStateFilter;
    readonly pageSize?: InboxPageSize;
    readonly selectedLabels?: ReadonlyArray<string>;
    readonly awaitingMyReview?: boolean;
    readonly pageToken?: string | undefined;
    readonly previousPageTokens?: ReadonlyArray<string | undefined>;
  } = {},
): InboxRequestState {
  const repository = Object.hasOwn(overrides, "repository")
    ? overrides.repository
    : current.repository;
  const repositoryField = repository === undefined ? {} : { repository };
  const pageTokenField =
    overrides.pageToken === undefined ? {} : { pageToken: overrides.pageToken };
  return {
    ...repositoryField,
    ...pageTokenField,
    state: overrides.state ?? current.state,
    pageSize: overrides.pageSize ?? current.pageSize,
    selectedLabels: overrides.selectedLabels ?? current.selectedLabels,
    awaitingMyReview: overrides.awaitingMyReview ?? current.awaitingMyReview,
    previousPageTokens: overrides.previousPageTokens ?? [],
  };
}

/**
 * True when two requests would ask GitHub for the same rows.
 *
 * Every field that changes the answer is compared, because any of them
 * leaves the displayed rows describing the previous request until the new
 * one lands. Comparing the response instead cannot work: it echoes only the
 * state filter and the page size, and says nothing about the label filter or
 * the "Awaiting review from you" preset, so a label change looked identical
 * to no change at all.
 */
function sameInboxRows(
  left: InboxRequestState,
  right: InboxRequestState,
): boolean {
  return (
    sameRepositoryIdentity(left.repository, right.repository) &&
    left.state === right.state &&
    left.pageSize === right.pageSize &&
    left.awaitingMyReview === right.awaitingMyReview &&
    left.pageToken === right.pageToken &&
    left.selectedLabels.length === right.selectedLabels.length &&
    left.selectedLabels.every(
      (label, index) => label === right.selectedLabels[index],
    )
  );
}

const firstInboxRequest: InboxRequestState = {
  state: "open",
  pageSize: DEFAULT_INBOX_PAGE_SIZE,
  selectedLabels: [],
  awaitingMyReview: false,
  previousPageTokens: [],
};

/**
 * Guesses the request to build the very first inbox fetch from, before the
 * true active profile is confirmed. `profiles[0]` matches the main
 * process's own fallback (`DashboardController.activeProfile`) whenever no
 * profile has ever been explicitly selected — the common case, and the only
 * one this needs to get right up front. A wrong guess (an explicitly
 * selected, non-first profile) still self-corrects once the real active
 * profile is confirmed — see the `dashboard?.profile.id` effect below — so
 * getting it wrong here costs one extra refetch, not incorrect data. The
 * repository is deliberately left unset: sending one that turns out not to
 * belong to the true active profile's watchlist fails the whole request
 * server-side (`DashboardController.inboxForActiveProfile`), which a wrong
 * page-size guess never does.
 */
function firstInboxRequestFor(
  profiles: ReadonlyArray<Profile>,
): InboxRequestState {
  const profileId = profiles[0]?.id;
  if (profileId === undefined) return firstInboxRequest;
  const { state, pageSize, selectedLabels, awaitingMyReview } =
    loadInboxViewPreferences(profileId);
  return {
    state,
    pageSize,
    selectedLabels,
    awaitingMyReview,
    previousPageTokens: [],
  };
}

/** Builds the renderer-owned inbox URL without decoding the opaque page token. */
function inboxRequestPath(request: InboxRequestState): string {
  const query = new URLSearchParams({
    state: request.state,
    pageSize: String(request.pageSize),
  });
  if (request.repository !== undefined) {
    query.set("host", request.repository.host);
    query.set("owner", request.repository.owner);
    query.set("repo", request.repository.repo);
  }
  for (const label of request.selectedLabels) query.append("label", label);
  if (request.awaitingMyReview) query.set("awaitingMyReview", "1");
  if (request.pageToken !== undefined) query.set("page", request.pageToken);
  return `/v1/inbox?${query.toString()}`;
}

/**
 * Re-validates a request's repository against a freshly fetched profile
 * list before the request is sent — a repository the profile no longer
 * watches (removed in Settings while the screen still held it) would
 * otherwise be sent as-is and hard-rejected by `GET /v1/inbox`. Resetting
 * the cursor and clearing the label filter mirror an explicit picker change
 * (see `resolveInboxRepository`'s doc comment) because, from the request's
 * point of view, this is the same kind of change.
 *
 * Only meaningful once the active profile is already known and unchanged.
 * A profile switch resets the request to `firstInboxRequest` beforehand and
 * never reaches here with a non-bootstrap `base`; the repository for that
 * case is corrected afterward instead, once the new active profile is
 * confirmed (see the `dashboard?.profile.id` effect below).
 */
function reconcileInboxRepository(
  base: InboxRequestState,
  profiles: ReadonlyArray<Profile>,
  activeProfileId: string | undefined,
): InboxRequestState {
  const profile = profiles.find(
    (candidate) => candidate.id === activeProfileId,
  );
  if (profile === undefined) return base;
  const repository = resolveInboxRepository(
    profile.repos ?? [],
    loadInboxViewPreferences(profile.id).selectedRepository,
  );
  if (sameRepositoryIdentity(repository, base.repository)) return base;
  const selectedRepositoryField =
    repository === undefined ? {} : { selectedRepository: repository };
  saveInboxViewPreferences(profile.id, {
    ...selectedRepositoryField,
    selectedLabels: [],
  });
  return nextInboxRequest(base, { repository, selectedLabels: [] });
}

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
// App is the renderer's root component. It owns the dashboard, navigation,
// and screen routing for the whole app.
// Splitting this component into smaller files is scheduled work, not done yet.
// Until that split lands, the file size ratchet blocks this file from growing.
// react-doctor-disable-next-line react-doctor/no-giant-component -- see comment above
export function App({
  initialState,
  reviewWorkbenchLoader = loadReviewWorkbench,
  fixtureContentLoader = loadFixtureContent,
  performanceFixtureLoader = loadPerformanceFixture,
}: AppProps): React.JSX.Element {
  const fixtureHash =
    globalThis.window === undefined ? "" : window.location.hash;
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
      globalThis.window === undefined
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
  const [inboxRequest, setInboxRequest] =
    useState<InboxRequestState>(firstInboxRequest);
  /** The request whose rows `inbox` currently holds; `undefined` until the
   * first read lands. Compared against `inboxRequest` to decide whether the
   * row list is showing the previous request's answer. */
  const [confirmedInboxRequest, setConfirmedInboxRequest] =
    useState<InboxRequestState>();
  const inboxRequestRef = useRef<InboxRequestState>(firstInboxRequest);
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
    if (window.matchMedia === undefined) return undefined;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [appearance]);
  useEffect(() => {
    applyDiffThemePreferences(diffThemePreferences);
  }, [diffThemePreferences]);
  useEffect(() => {
    if (fixtureMode || window.patchdesk?.request === undefined) return;
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
  const restoredInboxStateProfileId = useRef<string | undefined>(undefined);
  const resetInboxStateOnProfileLoad = useRef(false);
  const workspaceGeneration = useRef(0);
  const inboxRefreshGeneration = useRef(0);
  const [navigationState, setNavigationState] =
    useState<NavigationState>("clear");
  const [pendingDestination, setPendingDestination] =
    useState<AppDestination>();
  const updateInboxRequest = useCallback((next: InboxRequestState): void => {
    inboxRequestRef.current = next;
    setInboxRequest(next);
  }, []);
  const loadWorkspace = useCallback(async (): Promise<void> => {
    const generation = ++workspaceGeneration.current;
    inboxRefreshGeneration.current += 1;
    if (globalThis.window === undefined || !("patchdesk" in window)) {
      dispatchWorkspace({ _tag: "failed", screen: initialState ?? "empty" });
      return;
    }
    dispatchWorkspace({ _tag: "loading" });
    let profilePayload: unknown;
    let inboxPayload: unknown;
    let nextProfiles: ReadonlyArray<Profile> = [];
    try {
      profilePayload = await api("/v1/profiles");
      nextProfiles = Array.isArray(profilePayload)
        ? profilePayload.filter(isProfile)
        : [];
      // The bootstrap request (`firstInboxRequest`) never knows the saved
      // page size or state filter up front. Guessing them from the just-fetched
      // profile list here — instead of always requesting the default and
      // correcting afterward once the real active profile is confirmed —
      // is what keeps a cold start to one `/v1/inbox` call instead of two.
      // A reload that already has a real request in flight (profile switch
      // mid-flight aside) is reconciled against the fresh watchlist instead
      // — see `reconcileInboxRepository` — so a repository removed from
      // Settings while this screen held it is never resent.
      const initialRequest =
        inboxRequestRef.current === firstInboxRequest
          ? firstInboxRequestFor(nextProfiles)
          : reconcileInboxRepository(
              inboxRequestRef.current,
              nextProfiles,
              activeInboxProfileId.current,
            );
      if (initialRequest !== inboxRequestRef.current)
        updateInboxRequest(initialRequest);
      inboxPayload = await api(inboxRequestPath(initialRequest));
      // The rows about to be shown are this request's answer. Without this
      // the row list would sit in its loading state forever after a cold
      // start, because nothing else records what produced them.
      setConfirmedInboxRequest(initialRequest);
    } catch {
      if (generation === workspaceGeneration.current)
        dispatchWorkspace({ _tag: "failed", screen: "error" });
      return;
    }
    if (generation !== workspaceGeneration.current) return;
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
      screen: screenStateForInbox(loadedInbox, currentDashboard),
    });
    activeInboxProfileId.current = currentDashboard.profile.id;
  }, [initialState, updateInboxRequest]);
  const refreshInbox = useCallback(
    async (
      request: InboxRequestState = inboxRequestRef.current,
    ): Promise<void> => {
      const profileId = activeInboxProfileId.current;
      if (profileId === undefined) return;
      const generation = ++inboxRefreshGeneration.current;
      dispatchWorkspace({ _tag: "refreshStarted" });
      try {
        const payload = await api(inboxRequestPath(request));
        const refreshed = parseInboxResponse(payload);
        if (
          refreshed === undefined ||
          refreshed.profile.id !== profileId ||
          refreshed.inbox.state !== request.state ||
          refreshed.inbox.pageSize !== request.pageSize
        )
          throw new Error("Invalid inbox refresh response");
        if (generation !== inboxRefreshGeneration.current) return;
        setConfirmedInboxRequest(request);
        const nextDashboard = dashboardFromInbox(refreshed);
        dispatchWorkspace({
          _tag: "refreshSucceeded",
          inbox: refreshed,
          dashboard: nextDashboard,
          screen: screenStateForInbox(refreshed, nextDashboard),
        });
      } catch {
        if (generation === inboxRefreshGeneration.current)
          dispatchWorkspace({ _tag: "refreshFailed" });
      } finally {
        if (generation === inboxRefreshGeneration.current)
          dispatchWorkspace({ _tag: "refreshFinished" });
      }
    },
    [],
  );
  useEffect(() => {
    const profileId = dashboard?.profile.id;
    if (
      profileId === undefined ||
      restoredInboxStateProfileId.current === profileId
    )
      return;
    restoredInboxStateProfileId.current = profileId;
    if (resetInboxStateOnProfileLoad.current) {
      resetInboxStateOnProfileLoad.current = false;
      return;
    }
    const preferences = loadInboxViewPreferences(profileId);
    // The bootstrap request (`firstInboxRequest`) never carries a
    // repository — the renderer does not learn the active profile's
    // watchlist until this response arrives. Once it has, every later
    // request sends the Selected repository explicitly, resolved from the
    // stored preference and this watchlist, so a request still missing one
    // is corrected here alongside the state filter and page size. An empty watchlist
    // resolves to `undefined`, so that alone must not force a redundant
    // second fetch.
    const repository = resolveInboxRepository(
      dashboard?.profile.repos ?? [],
      preferences.selectedRepository,
    );
    const repositoryChanged = !sameRepositoryIdentity(
      repository,
      inboxRequestRef.current.repository,
    );
    if (
      !repositoryChanged &&
      preferences.state === inboxRequestRef.current.state &&
      preferences.pageSize === inboxRequestRef.current.pageSize
    )
      return;
    if (repositoryChanged) {
      const selectedRepositoryField =
        repository === undefined ? {} : { selectedRepository: repository };
      saveInboxViewPreferences(profileId, {
        ...selectedRepositoryField,
        selectedLabels: [],
      });
    }
    const request = nextInboxRequest(inboxRequestRef.current, {
      repository,
      state: preferences.state,
      pageSize: preferences.pageSize,
      selectedLabels: repositoryChanged ? [] : preferences.selectedLabels,
      awaitingMyReview: preferences.awaitingMyReview,
    });
    updateInboxRequest(request);
    void refreshInbox(request);
  }, [
    dashboard?.profile.id,
    dashboard?.profile.repos,
    refreshInbox,
    updateInboxRequest,
  ]);
  useEffect(() => {
    if (!fixtureMode) void loadWorkspace();
  }, [fixtureMode, loadWorkspace]);
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
    if (fixtureMode || window.patchdesk?.request === undefined) return;
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
  const refreshDashboard = useCallback(async (): Promise<void> => {
    const request = nextInboxRequest(inboxRequestRef.current);
    updateInboxRequest(request);
    await refreshInbox(request);
  }, [refreshInbox, updateInboxRequest]);
  useEffect(() => {
    if (fixtureMode || window.patchdesk?.onNavigate === undefined) return;
    return window.patchdesk.onNavigate((next) => {
      if (next === "settings") openSettings();
      else if (next === "refresh") void refreshDashboard();
    });
  }, [fixtureMode, openSettings, refreshDashboard]);
  const changeInboxState = useCallback(
    (nextState: InboxRequestState["state"]): void => {
      const request = nextInboxRequest(inboxRequestRef.current, {
        state: nextState,
      });
      const profileId = activeInboxProfileId.current;
      if (profileId !== undefined)
        saveInboxViewPreferences(profileId, { state: nextState });
      updateInboxRequest(request);
      void refreshInbox(request);
    },
    [refreshInbox, updateInboxRequest],
  );
  const changeInboxPageSize = useCallback(
    (pageSize: InboxPageSize): void => {
      const request = nextInboxRequest(inboxRequestRef.current, { pageSize });
      const profileId = activeInboxProfileId.current;
      if (profileId !== undefined)
        saveInboxViewPreferences(profileId, { pageSize });
      updateInboxRequest(request);
      void refreshInbox(request);
    },
    [refreshInbox, updateInboxRequest],
  );
  /**
   * Changes the label filter — GitHub's `label:"NAME"` search
   * qualifier, never a local, in-page filter. Resets the page cursor: a
   * cursor minted under the previous label filter belongs to a different
   * search query and is rejected as `invalid_page`.
   */
  const changeInboxLabels = useCallback(
    (selectedLabels: ReadonlyArray<string>): void => {
      const request = nextInboxRequest(inboxRequestRef.current, {
        selectedLabels,
      });
      const profileId = activeInboxProfileId.current;
      if (profileId !== undefined)
        saveInboxViewPreferences(profileId, { selectedLabels });
      updateInboxRequest(request);
      void refreshInbox(request);
    },
    [refreshInbox, updateInboxRequest],
  );
  /**
   * Toggles the "Awaiting review from you" preset (ADR 0031) — GitHub's
   * `user-review-requested:@me` qualifier, which composes with the state and
   * label filters rather than replacing the listing. Resets the page cursor
   * for the same reason a label change does: the cursor was minted under a
   * different search query.
   */
  const changeInboxAwaitingMyReview = useCallback(
    (awaitingMyReview: boolean): void => {
      const request = nextInboxRequest(inboxRequestRef.current, {
        awaitingMyReview,
      });
      const profileId = activeInboxProfileId.current;
      if (profileId !== undefined)
        saveInboxViewPreferences(profileId, { awaitingMyReview });
      updateInboxRequest(request);
      void refreshInbox(request);
    },
    [refreshInbox, updateInboxRequest],
  );
  /**
   * Selects a repository from the picker. The Selected repository
   * is the screen's root state, so changing it resets the page cursor — a
   * cursor minted for the previous repository is rejected as `invalid_page`
   * — and clears the label filter, which is repository-scoped and may name a
   * label the new repository does not have.
   */
  const changeInboxRepository = useCallback(
    (repository: Repo): void => {
      if (
        sameRepositoryIdentity(repository, inboxRequestRef.current.repository)
      )
        return;
      const profileId = activeInboxProfileId.current;
      if (profileId !== undefined)
        saveInboxViewPreferences(profileId, {
          selectedRepository: repository,
          selectedLabels: [],
        });
      const request = nextInboxRequest(inboxRequestRef.current, {
        repository,
        selectedLabels: [],
      });
      updateInboxRequest(request);
      void refreshInbox(request);
    },
    [refreshInbox, updateInboxRequest],
  );
  const previousInboxPage = useCallback((): void => {
    const current = inboxRequestRef.current;
    if (current.previousPageTokens.length === 0) return;
    const pageToken = current.previousPageTokens.at(-1);
    const previousPageTokens = current.previousPageTokens.slice(0, -1);
    const next = nextInboxRequest(current, { pageToken, previousPageTokens });
    updateInboxRequest(next);
    void refreshInbox(next);
  }, [refreshInbox, updateInboxRequest]);
  const nextInboxPage = useCallback((): void => {
    const current = inboxRequestRef.current;
    const pageToken = inbox?.inbox.nextPageToken;
    if (pageToken === undefined) return;
    const next = nextInboxRequest(current, {
      pageToken,
      previousPageTokens: [
        ...current.previousPageTokens,
        current.pageToken,
      ].slice(-20),
    });
    updateInboxRequest(next);
    void refreshInbox(next);
  }, [inbox?.inbox.nextPageToken, refreshInbox, updateInboxRequest]);
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
    <BusyProvider>
      <TooltipProvider>
        <AppShell
          destination={next}
          navigationBlocked={navigationState !== "clear"}
          onNavigate={navigate}
          onOpenSettings={openSettings}
          profiles={profiles.map((p) => ({ id: p.id, label: p.label }))}
          activeProfileId={dashboard?.profile.id ?? inbox?.profile.id ?? ""}
          onInboxStateChange={changeInboxState}
          onProfileSwitch={async (id) => {
            await api("/v1/profiles/select", { method: "POST", body: { id } });
            saveInboxViewPreferences(id, { state: "open" });
            resetInboxStateOnProfileLoad.current = true;
            setWorkbench(undefined);
            dispatchWorkspace({ _tag: "cleared" });
            updateInboxRequest(firstInboxRequest);
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
            resetInboxStateOnProfileLoad.current = true;
            updateInboxRequest(firstInboxRequest);
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
    </BusyProvider>
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
            {...(restoredWorkbenchUi.current !== undefined &&
            restoredWorkbenchUi.current.reviewId === workbench.review.id
              ? { initialUiState: restoredWorkbenchUi.current.state }
              : {})}
            onUiStateChange={(state) =>
              saveWorkbenchUiState(workbench.review.id, state)
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
    destination.kind === "workbench" ? { reviewId: destination.reviewId } : {};
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
  // The confirmed inbox response still carries the previous request's rows
  // until the in-flight request for the new one lands. The filter bar
  // reflects `inboxRequest` immediately (so the click feels responsive), but
  // the row list must not present those stale rows as the new request's
  // answer — so InboxFlow gets this boolean and holds the list in a loading
  // state until the two agree.
  const inboxListPending =
    inbox !== undefined &&
    (confirmedInboxRequest === undefined ||
      !sameInboxRows(confirmedInboxRequest, inboxRequest));
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
          refreshFailed: inboxRefreshFailed,
          ...refreshedAtField,
        })}
        onRefresh={() => void refreshDashboard()}
        inboxState={inboxRequest.state}
        listPending={inboxListPending}
        pageSize={inboxRequest.pageSize}
        hasPreviousPage={inboxRequest.previousPageTokens.length > 0}
        hasNextPage={inbox?.inbox.nextPageToken !== undefined}
        onInboxStateChange={changeInboxState}
        onInboxPageSizeChange={changeInboxPageSize}
        selectedLabels={inboxRequest.selectedLabels}
        onInboxLabelsChange={changeInboxLabels}
        awaitingMyReview={inboxRequest.awaitingMyReview}
        onInboxAwaitingMyReviewChange={changeInboxAwaitingMyReview}
        {...(inboxRequest.repository === undefined
          ? {}
          : { selectedRepository: inboxRequest.repository })}
        onRepositoryChange={changeInboxRepository}
        onPreviousInboxPage={previousInboxPage}
        onNextInboxPage={nextInboxPage}
        onSettings={(section) => openSettings(undefined, section)}
        onOpenWorkbench={(next) => {
          setWorkbench(next);
          navigate({
            kind: "workbench",
            reviewId: next.review?.id ?? next.session.id,
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
