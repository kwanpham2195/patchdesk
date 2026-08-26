import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { inboxIdentityKey, type InboxRow } from "@/renderer-contracts";
import {
  loadInboxViewPreferences,
  saveInboxViewPreferences,
} from "@/inbox-view-preferences";

type InboxViewState = {
  readonly inspectorOpen: boolean;
  readonly selectedKey?: string;
};

type InboxViewAction =
  | { readonly _tag: "preferencesLoaded"; readonly state: InboxViewState }
  | { readonly _tag: "rowSelected"; readonly selectedKey: string }
  | { readonly _tag: "inspectorToggled" };

function inboxViewState(
  preferences: ReturnType<typeof loadInboxViewPreferences>,
): InboxViewState {
  const state: InboxViewState = { inspectorOpen: preferences.inspectorOpen };
  return preferences.selectedIdentity === undefined
    ? state
    : { ...state, selectedKey: preferences.selectedIdentity };
}

function inboxViewReducer(
  state: InboxViewState,
  action: InboxViewAction,
): InboxViewState {
  switch (action._tag) {
    case "preferencesLoaded":
      return action.state;
    case "rowSelected":
      return { ...state, selectedKey: action.selectedKey };
    case "inspectorToggled":
      return { ...state, inspectorOpen: !state.inspectorOpen };
  }
}

function requestAction(
  row: InboxRow,
  onOpenReview: (row: InboxRow) => void,
  onOpenReviewId: (reviewId: string) => void,
): void {
  switch (row.recommendedAction.kind) {
    case "run_review":
      onOpenReview(row);
      return;
    case "open_merged_review":
      onOpenReview(row);
      return;
    case "open_saved_review":
    case "open_merge_readiness":
      onOpenReviewId(row.recommendedAction.reviewId);
      return;
  }
}

// `window` or `window.matchMedia` may be absent when this runs under
// node/jsdom test environments, so every caller reaches this indirectly.
function narrowViewportQuery(): MediaQueryList | undefined {
  return globalThis.window?.matchMedia?.("(max-width: 1279px)");
}
function isNarrowViewport(): boolean {
  return narrowViewportQuery()?.matches ?? false;
}

/**
 * Owns the maintainer inbox's local view state (selection, inspector,
 * keyboard navigation) over `rows` — already the exact, server-filtered and
 * server-ordered page GitHub returned; this hook does no filtering or
 * sorting of its own (see ADR 0031/0032). Extracted out of
 * `MaintainerInbox` to keep that component under the
 * renderer's giant-component guardrail.
 */
export function useInboxView(params: {
  readonly profileId: string;
  readonly rows: ReadonlyArray<InboxRow>;
  readonly onOpenReview: (row: InboxRow) => void;
  readonly onOpenReviewId: (reviewId: string) => void;
}) {
  const { profileId, rows, onOpenReview, onOpenReviewId } = params;
  const preferences = useMemo(
    () => loadInboxViewPreferences(profileId),
    [profileId],
  );
  const [inboxView, dispatchInboxView] = useReducer(
    inboxViewReducer,
    preferences,
    inboxViewState,
  );
  const { inspectorOpen, selectedKey } = inboxView;
  const [narrow, setNarrow] = useState(() => isNarrowViewport());
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const query = narrowViewportQuery();
    if (query === undefined) return;
    const update = (): void => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const next = loadInboxViewPreferences(profileId);
    dispatchInboxView({
      _tag: "preferencesLoaded",
      state: inboxViewState(next),
    });
  }, [profileId]);

  const selected =
    rows.find((row) => inboxIdentityKey(row) === selectedKey) ?? rows[0];

  const triggerAction = useCallback(
    (row: InboxRow): void => requestAction(row, onOpenReview, onOpenReviewId),
    [onOpenReview, onOpenReviewId],
  );

  const selectRow = (row: InboxRow): void => {
    const key = inboxIdentityKey(row);
    dispatchInboxView({ _tag: "rowSelected", selectedKey: key });
    saveInboxViewPreferences(profileId, { selectedIdentity: key });
  };
  const toggleInspector = (): void => {
    const next = !inspectorOpen;
    dispatchInboxView({ _tag: "inspectorToggled" });
    saveInboxViewPreferences(profileId, { inspectorOpen: next });
  };
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (rows.length === 0) return;
    const first = rows[0];
    if (first === undefined) return;
    const currentIndex = Math.max(
      0,
      rows.findIndex(
        (row) => inboxIdentityKey(row) === inboxIdentityKey(selected ?? first),
      ),
    );
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const next = rows[(currentIndex + offset + rows.length) % rows.length];
      if (next === undefined) return;
      selectRow(next);
      document.getElementById(`inbox-row-${inboxIdentityKey(next)}`)?.focus();
    }
    if (event.key === "Enter" && selected !== undefined)
      triggerAction(selected);
  };

  // The command palette's "Open selected pull request" entry has no other
  // way to reach the currently selected row, which lives only here — a
  // window event stays the practical choice for that one case (see
  // app-shell.tsx).
  useEffect(() => {
    const onAction = (): void => {
      if (selected !== undefined) triggerAction(selected);
    };
    window.addEventListener("patchdesk:inbox-action", onAction);
    return () => window.removeEventListener("patchdesk:inbox-action", onAction);
  }, [selected, triggerAction]);

  return {
    inspectorOpen,
    narrow,
    listRef,
    selected,
    triggerAction,
    selectRow,
    toggleInspector,
    onListKeyDown,
  };
}
