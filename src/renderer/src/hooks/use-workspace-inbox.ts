import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
} from "react";
import { api } from "../api-client";
import {
  loadInboxViewPreferences,
  saveInboxViewPreferences,
} from "../inbox-view-preferences";
import {
  firstInboxRequest,
  firstInboxRequestFor,
  inboxRequestPath,
  nextInboxRequest,
  reconcileInboxRepository,
  resolveInboxRepository,
  sameInboxRows,
  type InboxRequestState,
} from "../inbox-request";
import { parseInboxResponse, type InboxResponse } from "../renderer-contracts";
import type {
  Dashboard,
  DashboardScreenState,
  Profile,
  Repo,
} from "../renderer-models";
import { screenStateForInbox } from "../screen-state-for-inbox";
import {
  dashboardFromInbox,
  isProfile,
  workspaceReducer,
  type WorkspaceAction,
} from "../workspace-state";
import {
  parseInboxAuthorFilter,
  parseInboxBaseBranchFilter,
  type InboxCheckStatusFilter,
  type InboxFilterTextFailure,
  type InboxPageSize,
  type InboxReviewStateFilter,
} from "../../../domain/maintainer-inbox";
import { sameRepositoryIdentity } from "../../../domain/repository-identity";
import { ok, type Result } from "../../../domain/result";

/**
 * The Pull requests screen's whole read path: the workspace the renderer has
 * loaded, the request that produced its rows, and every control that changes
 * that request.
 *
 * Two generation counters guard it. `workspaceGeneration` discards a cold
 * start whose profile or inbox read was overtaken by a newer one;
 * `inboxRefreshGeneration` does the same for a refresh, and is also bumped
 * whenever the active profile changes so an in-flight read for the old
 * profile cannot land against the new one. They are carried here unchanged
 * from `app.tsx`; the plan's `useKeyedAsync` (S4c) is meant to replace both,
 * and that helper does not exist yet.
 *
 * The refs and `dispatchWorkspace` are returned because the profile-switch
 * handlers in `app.tsx` still drive them directly. Folding those two handlers
 * into this hook is the next slice's work, not this one's.
 */
export type WorkspaceInbox = {
  readonly profiles: ReadonlyArray<Profile>;
  readonly dashboard: Dashboard | undefined;
  readonly inbox: InboxResponse | undefined;
  readonly state: DashboardScreenState;
  readonly inboxRefreshing: boolean;
  readonly inboxRefreshFailed: boolean;
  readonly inboxRequest: InboxRequestState;
  /** True while the shown rows still answer the previous request. */
  readonly inboxListPending: boolean;
  readonly dispatchWorkspace: Dispatch<WorkspaceAction>;
  readonly updateInboxRequest: (next: InboxRequestState) => void;
  readonly loadWorkspace: () => Promise<void>;
  readonly refreshDashboard: () => Promise<void>;
  readonly changeInboxState: (nextState: InboxRequestState["state"]) => void;
  readonly changeInboxPageSize: (pageSize: InboxPageSize) => void;
  readonly changeInboxLabels: (selectedLabels: ReadonlyArray<string>) => void;
  readonly changeInboxAwaitingMyReview: (awaitingMyReview: boolean) => void;
  readonly changeInboxReviewState: (
    reviewState: InboxReviewStateFilter | undefined,
  ) => void;
  readonly changeInboxCheckStatus: (
    checkStatus: InboxCheckStatusFilter | undefined,
  ) => void;
  /** Returns the broken rule when the value is refused: nothing is saved, sent, or refreshed, and the field reports it. */
  readonly changeInboxAuthor: (
    author: string | undefined,
  ) => InboxFilterTextFailure | undefined;
  readonly changeInboxBaseBranch: (
    baseBranch: string | undefined,
  ) => InboxFilterTextFailure | undefined;
  readonly clearInboxMoreFilters: () => void;
  readonly changeInboxRepository: (repository: Repo) => void;
  readonly previousInboxPage: () => void;
  readonly nextInboxPage: () => void;
  readonly activeInboxProfileId: RefObject<string | undefined>;
  readonly inboxRefreshGeneration: RefObject<number>;
  readonly resetInboxStateOnProfileLoad: RefObject<boolean>;
};

/** Resolves a free-text More filter to the value to send: an empty one clears the filter, while any other broken rule refuses the commit so the field can report it. */
function commitFilterText(
  value: string | undefined,
  parse: (value: string) => Result<string, InboxFilterTextFailure>,
): Result<string | undefined, InboxFilterTextFailure> {
  if (value === undefined) return ok(undefined);
  const parsed = parse(value);
  if (parsed._tag === "ok") return parsed;
  return parsed.error === "empty" ? ok(undefined) : parsed;
}

export function useWorkspaceInbox({
  fixtureMode,
  initialState,
}: {
  readonly fixtureMode: boolean;
  readonly initialState: DashboardScreenState | undefined;
}): WorkspaceInbox {
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
  const activeInboxProfileId = useRef<string | undefined>(undefined);
  const restoredInboxStateProfileId = useRef<string | undefined>(undefined);
  const resetInboxStateOnProfileLoad = useRef(false);
  const workspaceGeneration = useRef(0);
  const inboxRefreshGeneration = useRef(0);
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
      if (generation !== workspaceGeneration.current) return;
      // The bootstrap request (`firstInboxRequest`) never knows the saved
      // page size or state filter up front. Guessing them from the just-fetched
      // profile list here — instead of always requesting the default and
      // correcting afterward once the real active profile is confirmed —
      // is what keeps a cold start to one `/v1/inbox` call instead of two.
      // A reload that already has a real request in flight (profile switch
      // mid-flight aside) is reconciled against the fresh watchlist instead
      // — see `reconcileInboxRepository` — so a repository removed from
      // Settings while this screen held it is never resent.
      const initialRequest = resetInboxStateOnProfileLoad.current
        ? firstInboxRequest
        : inboxRequestRef.current === firstInboxRequest
          ? firstInboxRequestFor(nextProfiles)
          : reconcileInboxRepository(
              inboxRequestRef.current,
              nextProfiles,
              activeInboxProfileId.current,
            );
      if (initialRequest !== inboxRequestRef.current)
        updateInboxRequest(initialRequest);
      inboxPayload = await api(inboxRequestPath(initialRequest));
      if (generation !== workspaceGeneration.current) return;
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
    if (resetInboxStateOnProfileLoad.current) {
      resetInboxStateOnProfileLoad.current = false;
      if (!repositoryChanged) return;
      const selectedRepositoryField =
        repository === undefined ? {} : { selectedRepository: repository };
      saveInboxViewPreferences(profileId, {
        ...selectedRepositoryField,
        selectedLabels: [],
      });
      const request = nextInboxRequest(inboxRequestRef.current, {
        repository,
        selectedLabels: [],
      });
      updateInboxRequest(request);
      void refreshInbox(request);
      return;
    }
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
      reviewState: preferences.reviewState,
      checkStatus: preferences.checkStatus,
      author: preferences.author,
      baseBranch: preferences.baseBranch,
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
  const refreshDashboard = useCallback(async (): Promise<void> => {
    const request = nextInboxRequest(inboxRequestRef.current);
    updateInboxRequest(request);
    await refreshInbox(request);
  }, [refreshInbox, updateInboxRequest]);
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
  /** Changes GitHub's review-state qualifier and starts a fresh first page. */
  const changeInboxReviewState = useCallback(
    (reviewState: InboxReviewStateFilter | undefined): void => {
      const request = nextInboxRequest(inboxRequestRef.current, {
        reviewState,
      });
      const profileId = activeInboxProfileId.current;
      if (profileId !== undefined)
        saveInboxViewPreferences(profileId, { reviewState });
      updateInboxRequest(request);
      void refreshInbox(request);
    },
    [refreshInbox, updateInboxRequest],
  );
  /** Changes GitHub's check-status qualifier and starts a fresh first page. */
  const changeInboxCheckStatus = useCallback(
    (checkStatus: InboxCheckStatusFilter | undefined): void => {
      const request = nextInboxRequest(inboxRequestRef.current, {
        checkStatus,
      });
      const profileId = activeInboxProfileId.current;
      if (profileId !== undefined)
        saveInboxViewPreferences(profileId, { checkStatus });
      updateInboxRequest(request);
      void refreshInbox(request);
    },
    [refreshInbox, updateInboxRequest],
  );
  /** Changes GitHub's author qualifier and starts a fresh first page; a value the route would refuse is reported back instead of being saved or sent. */
  const changeInboxAuthor = useCallback(
    (value: string | undefined): InboxFilterTextFailure | undefined => {
      const parsed = commitFilterText(value, parseInboxAuthorFilter);
      if (parsed._tag === "err") return parsed.error;
      const author = parsed.value;
      const request = nextInboxRequest(inboxRequestRef.current, { author });
      const profileId = activeInboxProfileId.current;
      if (profileId !== undefined)
        saveInboxViewPreferences(profileId, { author });
      updateInboxRequest(request);
      void refreshInbox(request);
      return undefined;
    },
    [refreshInbox, updateInboxRequest],
  );
  /** Changes GitHub's base-branch qualifier; empty clears it and a refused value is reported, as for the author. */
  const changeInboxBaseBranch = useCallback(
    (value: string | undefined): InboxFilterTextFailure | undefined => {
      const parsed = commitFilterText(value, parseInboxBaseBranchFilter);
      if (parsed._tag === "err") return parsed.error;
      const baseBranch = parsed.value;
      const request = nextInboxRequest(inboxRequestRef.current, { baseBranch });
      const profileId = activeInboxProfileId.current;
      if (profileId !== undefined)
        saveInboxViewPreferences(profileId, { baseBranch });
      updateInboxRequest(request);
      void refreshInbox(request);
      return undefined;
    },
    [refreshInbox, updateInboxRequest],
  );
  /** Clears all four More filters as one profile update and one inbox request. */
  const clearInboxMoreFilters = useCallback((): void => {
    const cleared = {
      reviewState: undefined,
      checkStatus: undefined,
      author: undefined,
      baseBranch: undefined,
    };
    const request = nextInboxRequest(inboxRequestRef.current, cleared);
    const profileId = activeInboxProfileId.current;
    if (profileId !== undefined) saveInboxViewPreferences(profileId, cleared);
    updateInboxRequest(request);
    void refreshInbox(request);
  }, [refreshInbox, updateInboxRequest]);
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
  return {
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
  };
}
