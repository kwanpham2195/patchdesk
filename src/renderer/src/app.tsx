import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { AppShell } from "./components/app-shell";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { Card, CardContent } from "./components/ui/card";
import { fixtureDestination, isFixtureHash } from "./flows/fixture-routes";
import { InboxFlow } from "./flows/inbox-flow";
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
import {
  useAppNavigation,
  type NavigationState,
} from "./hooks/use-app-navigation";
import { useDesktopMenuBridge } from "./hooks/use-desktop-menu-bridge";
import { useGlobalPreferences } from "./hooks/use-global-preferences";
import {
  useReviewWorkbenchRoute,
  type ReviewWorkbenchLoader,
} from "./hooks/use-review-workbench-route";
import { useSettingsOverlay } from "./hooks/use-settings-overlay";
import { useWorkspaceInbox } from "./hooks/use-workspace-inbox";
import { useProfileSwitch } from "./hooks/use-profile-switch";
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
  const LazyFixtureContent = useMemo(
    () => lazy(fixtureContentLoader),
    [fixtureContentLoader],
  );
  const LazyPerformanceFixture = useMemo(
    () => lazy(performanceFixtureLoader),
    [performanceFixtureLoader],
  );
  const {
    destination,
    setDestination,
    workbench,
    setWorkbench,
    navigationState,
    setNavigationState,
    pendingDestination,
    setPendingDestination,
    performNavigation,
    navigate,
  } = useAppNavigation();
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
    openSettings,
    settingsOpen,
    setSettingsOpen,
    settingsOpener,
    setSettingsOpener,
    settingsSection,
  } = useSettingsOverlay({ fixtureMode, navigationState });
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
    changeInboxAwaitingMyReview,
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
      setWorkbench(undefined);
      dispatchWorkspace({ _tag: "cleared" });
      activeInboxProfileId.current = undefined;
      inboxRefreshGeneration.current += 1;
      updateInboxRequest(firstInboxRequest);
      setDestination({ kind: "dashboard" });
      window.localStorage.setItem("patchdesk.destination", "dashboard");
      await loadWorkspace();
    },
    [
      activeInboxProfileId,
      dispatchWorkspace,
      inboxRefreshGeneration,
      loadWorkspace,
      resetInboxStateOnProfileLoad,
      setDestination,
      setWorkbench,
      updateInboxRequest,
    ],
  );
  const { profileSwitchState, switchProfile } = useProfileSwitch(
    applyLatestProfileSwitch,
  );
  useDesktopMenuBridge({
    fixtureMode,
    navigationState,
    openSettings,
    refreshDashboard,
  });

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
          profileSwitchState={profileSwitchState}
          onInboxStateChange={changeInboxState}
          onProfileSwitch={(id) => {
            void switchProfile(id, "header");
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
          profileSwitchState={profileSwitchState}
          onProfileSwitch={(id) => switchProfile(id, "settings")}
          onCleanupSuccess={(action) => {
            if (action === "local") performNavigation({ kind: "dashboard" });
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
