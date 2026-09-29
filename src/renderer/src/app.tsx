import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { agentMarkerInputs } from "./agent-run-requests";
import { AppShell } from "./components/app-shell";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { Card, CardContent } from "./components/ui/card";
import { fixtureDestination, isFixtureHash } from "./flows/fixture-routes";
import { InboxFlow } from "./flows/inbox-flow";
import { DiagnosticsModal } from "./components/diagnostics-modal";
import { LocalReviewSourceDialog } from "./components/local-review-source-dialog";
import { SettingsModal } from "./components/settings-modal";
import type { DashboardScreenState } from "./renderer-models";
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
import { PullRequestImageCacheProvider } from "./hooks/use-pull-request-image";
import {
  useAppNavigation,
  type LeftWorkbench,
  type NavigationState,
} from "./hooks/use-app-navigation";
import { useDesktopMenuBridge } from "./hooks/use-desktop-menu-bridge";
import { useDiagnosticsOverlay } from "./hooks/use-diagnostics-overlay";
import { useDesktopNotificationClicks } from "./hooks/use-desktop-notifications";
import { useGlobalPreferences } from "./hooks/use-global-preferences";
import {
  useReviewWorkbenchRoute,
  type ReviewWorkbenchLoader,
} from "./hooks/use-review-workbench-route";
import { useSettingsOverlay } from "./hooks/use-settings-overlay";
import { useWorkspaceInbox } from "./hooks/use-workspace-inbox";
import { useProfileSwitch } from "./hooks/use-profile-switch";
import { WatchedPullRequestsProvider } from "./hooks/use-watched-pull-requests";
import type { AppDestination } from "./routes";
import {
  clearSettingsRestore,
  saveSettingsRestore,
  saveWorkbenchUiState,
} from "./lib/screen-restore";
import type { WorkbenchResponse } from "./renderer-contracts";
import { saveInboxViewPreferences } from "./inbox-view-preferences";
import { inboxFreshnessLabel } from "./inbox-freshness";
import { firstInboxRequest } from "./inbox-request";
import { parseGitHubHost } from "../../domain/ids";
import type { PullRequestRef } from "../../domain/pull-request";
import { sameRepositoryIdentity } from "../../domain/repository-identity";
import { definedProps } from "../../domain/defined-props";
import { useInboxReviewOpening } from "./flows/use-inbox-review-opening";
import {
  useLocalRowOpen,
  type LocalCheckoutTarget,
} from "./flows/use-local-row-open";
import type { SidebarLocalRepositoryRow } from "./sidebar-contracts";
import { requestJson } from "./api-client";
import { localBranchesPath } from "./local-branches";
import { localCheckoutsPath } from "./local-checkouts";
import { appLog } from "./lib/logger";

export type { ReviewWorkbenchLoader };

type FixtureContentComponent = React.ComponentType<{
  readonly hash: string;
  readonly onNavigationStateChange: (state: NavigationState) => void;
}>;
type PerformanceFixtureComponent = React.ComponentType;
type RouteLoadBoundaryProps = {
  readonly children: ReactNode;
  readonly onRetry: () => void;
};

type FixtureContentLoader = () => Promise<{
  readonly default: FixtureContentComponent;
}>;
type PerformanceFixtureLoader = () => Promise<{
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
export function App({ ...props }: AppProps): React.JSX.Element {
  return (
    <BusyProvider>
      <PullRequestImageCacheProvider>
        <AppContent {...props} />
      </PullRequestImageCacheProvider>
    </BusyProvider>
  );
}

// AppContent owns dashboard, navigation, and screen routing. Splitting it into
// smaller files is scheduled work; the file size ratchet blocks growth.
// react-doctor-disable-next-line react-doctor/no-giant-component -- see comment above
function AppContent({
  initialState,
  reviewWorkbenchLoader = loadReviewWorkbench,
  fixtureContentLoader = loadFixtureContent,
  performanceFixtureLoader = loadPerformanceFixture,
}: AppProps): React.JSX.Element {
  const fixtureHash =
    globalThis.window === undefined ? "" : window.location.hash;
  const fixtureMode = isFixtureHash(fixtureHash);
  const LazyFixtureContent = useMemo(
    () => lazy(fixtureContentLoader),
    [fixtureContentLoader],
  );
  const LazyPerformanceFixture = useMemo(
    () => lazy(performanceFixtureLoader),
    [performanceFixtureLoader],
  );
  const leaveWorkbench = useCallback(
    (left: LeftWorkbench): void => {
      if (fixtureMode) return;
      // A lost cursor write only costs the next visit's marks, so it is logged rather than shown.
      void requestJson("/v1/reviews/leave", {
        method: "POST",
        body: left,
      }).catch(() =>
        appLog.warn(
          "review-workbench",
          "recording the last-looked cursor failed",
          {
            reviewId: left.reviewId,
          },
        ),
      );
    },
    [fixtureMode],
  );
  const {
    destination,
    workbench,
    setWorkbench,
    navigationState,
    setNavigationState,
    bootRestoredDestination,
    pendingDestination,
    setPendingDestination,
    performNavigation,
    navigate,
  } = useAppNavigation(leaveWorkbench);
  const {
    LazyReviewWorkbench,
    restoredWorkbenchUi,
    reviewLoaderGeneration,
    setReviewLoaderGeneration,
  } = useReviewWorkbenchRoute({
    destination,
    fixtureMode,
    reviewWorkbenchLoader,
    workbench,
  });
  const {
    diagnosticsOpen,
    diagnosticsOpener,
    openDiagnostics: openDiagnosticsOverlay,
    closeDiagnostics,
  } = useDiagnosticsOverlay(navigationState);
  const {
    openSettings,
    settingsOpen,
    setSettingsOpen,
    settingsOpener,
    setSettingsOpener,
    settingsSection,
  } = useSettingsOverlay({ fixtureMode, navigationState, diagnosticsOpen });
  // Settings refuses to open over Diagnostics inside its hook; the hooks' state would be circular, so the reverse refusal lives here.
  const openDiagnostics = useCallback(
    (opener?: HTMLElement): void => {
      if (!settingsOpen) openDiagnosticsOverlay(opener);
    },
    [openDiagnosticsOverlay, settingsOpen],
  );
  const {
    appearance,
    diffThemePreferences,
    preferenceError,
    updateAppearance,
    updateDiffTheme,
    retryPreferences,
  } = useGlobalPreferences(fixtureMode);
  const {
    profiles,
    unsavedProfile,
    dashboard,
    inbox,
    state,
    inboxRefreshing,
    inboxRefreshFailed,
    inboxRequest,
    inboxListPending,
    dispatchWorkspace,
    updateInboxRequest,
    loadWorkspace,
    refreshDashboard,
    changeInboxState,
    changeInboxPageSize,
    changeInboxLabels,
    labelFits,
    changeInboxPreset,
    changeInboxReviewState,
    changeInboxCheckStatus,
    changeInboxAuthor,
    changeInboxBaseBranch,
    clearInboxMoreFilters,
    changeInboxRepository,
    previousInboxPage,
    nextInboxPage,
    activeInboxProfileId,
    inboxRefreshGeneration,
    resetInboxStateOnProfileLoad,
  } = useWorkspaceInbox({ fixtureMode, initialState });
  const applyLatestProfileSwitch = useCallback(
    async (id: string): Promise<void> => {
      saveInboxViewPreferences(id, { state: "open" });
      resetInboxStateOnProfileLoad.current = true;
      // Leaves a held Review, so the switch records its cursor like any other leave.
      performNavigation({ kind: "dashboard" });
      dispatchWorkspace({ _tag: "cleared" });
      activeInboxProfileId.current = undefined;
      inboxRefreshGeneration.current += 1;
      updateInboxRequest(firstInboxRequest);
      await loadWorkspace();
    },
    [
      activeInboxProfileId,
      dispatchWorkspace,
      inboxRefreshGeneration,
      loadWorkspace,
      performNavigation,
      resetInboxStateOnProfileLoad,
      updateInboxRequest,
    ],
  );
  const { profileSwitchState, switchProfile } = useProfileSwitch(
    applyLatestProfileSwitch,
  );
  // A workspace switch or Clear local review data waits here behind the leave-confirmation (#635).
  const [parkedLeave, setParkedLeave] = useState<{
    readonly settle: (leave: boolean) => void;
    readonly returnFocus: HTMLElement | null;
  }>();
  const confirmLeaveReview = useCallback(
    (returnFocus: HTMLElement | null = null): Promise<boolean> =>
      navigationState === "clear"
        ? Promise.resolve(true)
        : new Promise((settle) => setParkedLeave({ settle, returnFocus })),
    [navigationState],
  );
  const [visitedReloadKey, setVisitedReloadKey] = useState(0);
  // The sidebar's "agent" marker follows the open Review's requests and runs, so a change reads the column again.
  const agentMarker =
    workbench?.state === "review" ? agentMarkerInputs(workbench) : "";
  const [shownAgentMarker, setShownAgentMarker] = useState(agentMarker);
  if (shownAgentMarker !== agentMarker) {
    setShownAgentMarker(agentMarker);
    setVisitedReloadKey((key) => key + 1);
  }
  const openWorkbench = useCallback(
    (next: WorkbenchResponse): void => {
      setWorkbench(next);
      // Every open path funnels through here, so bumping the key is what puts
      // the pull request at the top of the visited column without a relaunch.
      setVisitedReloadKey((key) => key + 1);
      performNavigation({
        kind: "workbench",
        reviewId: next.review.id,
      });
    },
    [performNavigation, setWorkbench],
  );
  // The boot restore's way out when the saved Review it named is gone: leaving
  // the route also rewrites the stored destination, so the next launch starts
  // on the dashboard rather than asking for the same missing Review again.
  const returnToDashboard = useCallback((): void => {
    performNavigation({ kind: "dashboard" });
  }, [performNavigation]);
  const reviewOpening = useInboxReviewOpening({
    dashboard,
    onOpenWorkbench: openWorkbench,
  });
  const { openLocalReview, openPullRequestByRef, reportOpenError } =
    reviewOpening;
  // The open that waits behind the leave-confirmation for a local row click (#479).
  const [parkedLocalOpen, setParkedLocalOpen] = useState<LocalCheckoutTarget>();
  const profileId = dashboard?.profile.id;
  const localRowOpen = useLocalRowOpen({
    profileId,
    openLocalReview,
    reportOpenError,
  });
  const { openRow: openLocalRow } = localRowOpen;
  const rowDialogTarget = localRowOpen.dialogTarget;
  const openLocalRepositoryFromSidebar = useCallback(
    ({ host, owner, repo, checkout }: SidebarLocalRepositoryRow): void => {
      const target = { host, owner, repo, ...definedProps({ checkout }) };
      if (navigationState !== "clear") {
        setParkedLocalOpen(target);
        return;
      }
      void openLocalRow(target, () => navigate({ kind: "dashboard" }));
    },
    [navigate, navigationState, openLocalRow],
  );
  // The pull request a palette or notification open waits on behind the leave-confirmation (#606).
  const [parkedPullRequest, setParkedPullRequest] = useState<PullRequestRef>();
  const openWatchedPullRequest = useCallback(
    (ref: PullRequestRef, leave: () => void): void => {
      leave();
      const watched = (dashboard?.profile.repos ?? []).some((repo) =>
        sameRepositoryIdentity(repo, ref),
      );
      if (!watched) {
        reportOpenError(
          `Not opened: ${ref.owner}/${ref.repo} is not a watched repository.`,
        );
        return;
      }
      openPullRequestByRef(ref);
    },
    [dashboard?.profile.repos, openPullRequestByRef, reportOpenError],
  );
  const openPullRequestFromPalette = useCallback(
    (ref: PullRequestRef): void => {
      if (navigationState !== "clear") {
        setParkedPullRequest(ref);
        return;
      }
      openWatchedPullRequest(ref, () => navigate({ kind: "dashboard" }));
    },
    [navigate, navigationState, openWatchedPullRequest],
  );
  const notificationFocus = useDesktopNotificationClicks({
    enabled: !fixtureMode,
    destination,
    navigationState,
    navigate,
    openPullRequest: openPullRequestFromPalette,
  });
  const parsedProfileHost = parseGitHubHost(dashboard?.profile.githubHost);
  useDesktopMenuBridge({
    fixtureMode,
    destination,
    navigationState,
    openSettings,
    openDiagnostics,
    refreshDashboard,
  });

  // Stay hands focus to the workspace switcher that asked, since its chosen option is gone by then (#657).
  const [stayReturnFocus, setStayReturnFocus] = useState<HTMLElement | null>(
    null,
  );

  const shell = (
    content: React.ReactNode,
    next: AppDestination = destination,
  ): React.JSX.Element => (
    <TooltipProvider>
      <WatchedPullRequestsProvider
        profileId={dashboard?.profile.id ?? inbox?.profile.id ?? ""}
      >
        <AppShell
          destination={next}
          // An unsaved draft lets Navigate open; the leave dialog holds what it starts.
          navigationBlocked={navigationState === "write_pending"}
          onNavigate={navigate}
          onOpenLocalReview={openLocalRepositoryFromSidebar}
          onOpenSettings={openSettings}
          onOpenDiagnostics={openDiagnostics}
          profiles={profiles.map((p) => ({ id: p.id, label: p.label }))}
          activeProfileId={dashboard?.profile.id ?? inbox?.profile.id ?? ""}
          profileSwitchState={profileSwitchState}
          visitedReloadKey={visitedReloadKey}
          {...definedProps({ selectedRepository: inboxRequest.repository })}
          onInboxStateChange={changeInboxState}
          onInboxPresetChange={changeInboxPreset}
          {...(parsedProfileHost._tag === "ok"
            ? {
                pullRequestDefaultHost: parsedProfileHost.value,
                onOpenPullRequest: openPullRequestFromPalette,
              }
            : {})}
          onProfileSwitch={(id, returnFocus) => {
            void confirmLeaveReview(returnFocus).then((leave) => {
              if (leave) void switchProfile(id, "header");
            });
          }}
        >
          {content}
        </AppShell>
      </WatchedPullRequestsProvider>
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
        unsavedProfile={unsavedProfile}
        onWorkspaceReload={loadWorkspace}
        profileSwitchState={profileSwitchState}
        onProfileSwitch={async (id, returnFocus) =>
          (await confirmLeaveReview(returnFocus))
            ? switchProfile(id, "settings")
            : "obsolete"
        }
        confirmLeaveReview={confirmLeaveReview}
        onCleanupSuccess={(action) => {
          if (action === "local") performNavigation({ kind: "dashboard" });
        }}
        preferenceError={preferenceError}
        onRetryPreferences={retryPreferences}
      />
      <DiagnosticsModal
        open={diagnosticsOpen}
        onOpenChange={(open) => {
          if (!open) closeDiagnostics();
        }}
        opener={diagnosticsOpener}
        profileId={dashboard?.profile.id}
      />
      <AlertDialog
        open={
          pendingDestination !== undefined ||
          parkedLocalOpen !== undefined ||
          parkedPullRequest !== undefined ||
          parkedLeave !== undefined
        }
        onOpenChange={(open) => {
          if (open || navigationState === "write_pending") return;
          setStayReturnFocus(parkedLeave?.returnFocus ?? null);
          setPendingDestination(undefined);
          setParkedLocalOpen(undefined);
          setParkedPullRequest(undefined);
          parkedLeave?.settle(false);
          setParkedLeave(undefined);
        }}
      >
        <AlertDialogContent
          finalFocus={stayReturnFocus === null ? true : () => stayReturnFocus}
        >
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
                  setStayReturnFocus(null);
                  if (parkedLeave !== undefined) {
                    // Leaving before the switch or cleanup runs, so one that fails cannot leave the draft on screen unguarded.
                    performNavigation({ kind: "dashboard" });
                    parkedLeave.settle(true);
                  } else if (parkedLocalOpen !== undefined) {
                    // Leaving first unmounts the draft this confirmation discards.
                    performNavigation({ kind: "dashboard" });
                    void openLocalRow(parkedLocalOpen, () => undefined);
                  } else if (parkedPullRequest !== undefined) {
                    openWatchedPullRequest(parkedPullRequest, () =>
                      performNavigation({ kind: "dashboard" }),
                    );
                  } else if (pendingDestination !== undefined)
                    performNavigation(pendingDestination);
                  setNavigationState("clear");
                  setPendingDestination(undefined);
                  setParkedLocalOpen(undefined);
                  setParkedPullRequest(undefined);
                  setParkedLeave(undefined);
                }}
              >
                Discard changes and leave
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {rowDialogTarget === undefined || profileId === undefined ? null : (
        <LocalReviewSourceDialog
          repositoryLabel={`${rowDialogTarget.owner}/${rowDialogTarget.repo}`}
          checkoutsPath={localCheckoutsPath(profileId, rowDialogTarget)}
          branchesPath={(checkout) =>
            localBranchesPath(profileId, rowDialogTarget, checkout)
          }
          {...definedProps({ initialCheckout: rowDialogTarget.checkout })}
          onOpen={(source) => openLocalReview(rowDialogTarget, source)}
          onOpenChange={(open) => {
            if (!open) localRowOpen.closeDialog();
          }}
        />
      )}
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
            // A clicked Insight notification remounts its Review on that Insight.
            key={
              notificationFocus?.reviewId === workbench.review.id
                ? notificationFocus.generation
                : 0
            }
            workbench={workbench}
            {...definedProps({
              profileLabel:
                profiles.length > 1
                  ? profiles.find(
                      (profile) =>
                        profile.id === workbench.session.key.profileId,
                    )?.label
                  : undefined,
            })}
            {...(notificationFocus?.reviewId === workbench.review.id
              ? { initialUiState: notificationFocus.state }
              : restoredWorkbenchUi.current !== undefined &&
                  restoredWorkbenchUi.current.reviewId === workbench.review.id
                ? { initialUiState: restoredWorkbenchUi.current.state }
                : {})}
            onUiStateChange={(state) =>
              saveWorkbenchUiState(workbench.review.id, state)
            }
            onWorkbenchPatch={(patch) =>
              setWorkbench((current) => {
                // A write that settles after a Review switch patches only the Review it was sent for (#475).
                if (current?.review.id !== workbench.review.id) return current;
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
  const bootRestoreMissingField = bootRestoredDestination
    ? { onBootRestoreMissing: returnToDashboard }
    : {};
  const dashboardField = dashboard === undefined ? {} : { dashboard };
  const inboxField = inbox === undefined ? {} : { inbox };
  const remoteField =
    inbox?.inbox.snapshot?.state === undefined
      ? {}
      : { remote: inbox.inbox.snapshot.state };
  return shell(
    <div className="flex min-h-0 flex-1 flex-col">
      <InboxFlow
        destination={destination.kind}
        {...reviewIdField}
        {...bootRestoreMissingField}
        onStoredReviewRefused={returnToDashboard}
        {...dashboardField}
        unsavedProfile={unsavedProfile}
        {...inboxField}
        state={state}
        refreshStatus={inboxFreshnessLabel({
          ...remoteField,
          refreshing: inboxRefreshing,
          refreshFailed: inboxRefreshFailed,
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
        labelFits={labelFits}
        {...(inboxRequest.preset === undefined
          ? {}
          : { preset: inboxRequest.preset })}
        onInboxPresetChange={changeInboxPreset}
        {...(inboxRequest.reviewState === undefined
          ? {}
          : { reviewState: inboxRequest.reviewState })}
        onInboxReviewStateChange={changeInboxReviewState}
        {...(inboxRequest.checkStatus === undefined
          ? {}
          : { checkStatus: inboxRequest.checkStatus })}
        onInboxCheckStatusChange={changeInboxCheckStatus}
        {...(inboxRequest.author === undefined
          ? {}
          : { author: inboxRequest.author })}
        onInboxAuthorChange={changeInboxAuthor}
        {...(inboxRequest.baseBranch === undefined
          ? {}
          : { baseBranch: inboxRequest.baseBranch })}
        onInboxBaseBranchChange={changeInboxBaseBranch}
        onClearInboxMoreFilters={clearInboxMoreFilters}
        {...(inboxRequest.repository === undefined
          ? {}
          : { selectedRepository: inboxRequest.repository })}
        onRepositoryChange={changeInboxRepository}
        onPreviousInboxPage={previousInboxPage}
        onNextInboxPage={nextInboxPage}
        onSettings={(section) => openSettings(undefined, section)}
        onWorkspaceReload={loadWorkspace}
        reviewOpening={reviewOpening}
      />
    </div>,
  );
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
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Card className="w-full max-w-lg">
          <CardContent>
            <Alert variant="destructive">
              <AlertTitle>
                Patchdesk could not load the Review workbench.
              </AlertTitle>
              <AlertDescription>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={this.props.onRetry}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </div>
    );
  }
}
