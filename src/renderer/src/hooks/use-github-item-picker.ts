import { useEffect, useMemo, useRef, useState } from "react";

import type { RepositoryLabelPermission } from "../../../domain/github-context";
import { PatchdeskApiError } from "../api-client";
import {
  projectReadState,
  type GithubListReadState,
  type GithubListResponse,
} from "../github-read-failure-copy";
import { withoutMember } from "../picker-selection";

/** How long the search box waits after the last keystroke before it re-queries the server-side filter — long enough to absorb normal typing cadence, short enough to still feel live. */
const SEARCH_DEBOUNCE_MS = 200;

/**
 * The reads and writes one picker needs, already narrowed to a single item:
 * the picker adapts its own wire-shaped actions (`addAssignees([{id, login}])`,
 * `addLabels([{id, name}])`, …) into these once, so this hook never has to
 * know which field names a given GitHub list uses.
 */
export type GithubItemPickerActions<TItem, TResponse> = {
  /** Fetches the candidate list, optionally filtered server-side. Pickers without a search box ignore the query. */
  readonly fetchList: (
    query: string | undefined,
  ) => Promise<TResponse | undefined>;
  readonly add: (item: TItem) => Promise<void>;
  readonly remove: (item: TItem) => Promise<void>;
};

/** Everything a picker renders from, and the two commands it renders controls for. */
export type GithubItemPicker<TItem, TReady> = {
  /** Whether the popover is open. The list is (re-)fetched each time this turns true. */
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  /** The search box's raw value; the fetch runs on its debounced form. */
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly readState: GithubListReadState<TReady>;
  /**
   * The read path's permission, or `"unknown"` before a list has landed.
   * Never inferred from a failed write.
   */
  readonly permission: RepositoryLabelPermission;
  /** The last failed write's sentence, cleared when another toggle starts. */
  readonly writeError: string | undefined;
  /** Whether this item reads as attached right now, optimistic overrides included. */
  readonly isAttached: (item: TItem) => boolean;
  /** Whether this item has a write in flight. */
  readonly isBusy: (item: TItem) => boolean;
  /** Applies the guess immediately, issues the write, and reverts the guess if the write fails. */
  readonly toggle: (item: TItem, nextAttached: boolean) => void;
};

/**
 * The state machine behind every rail picker that toggles membership in a
 * GitHub-owned list: repository labels, assignable people, reviewer
 * candidates. It owns the popover's open state, the debounced server-side
 * search, the read projection with its stale-response guard, the optimistic
 * add/remove overrides and their reconciliation against the authoritative
 * `attached` prop, and the revert-with-a-reason path when a write fails.
 *
 * Each picker keeps everything this hook has no opinion about: its trigger,
 * its popover copy, its permission notices, and how it draws a row.
 *
 * The three pickers' surfaces differ in ways this hook deliberately does not
 * flatten. `LabelPicker` has no search box, so it never calls `setQuery` and
 * its `fetchList` ignores the argument. `ReviewerPicker` renders two groups
 * (GitHub's suggestions above the remaining candidates) out of one `TReady`
 * payload. `AssigneePicker` states GitHub's ten-assignee cap up front. None
 * of that is state: it is rendering, and it stays in the component.
 *
 * `actions` is `undefined` when the Review can no longer accept this kind of
 * write. The hook still runs (a hook cannot be called conditionally), but it
 * fetches nothing and every `toggle` is a no-op; the picker renders `null`.
 */
export function useGithubItemPicker<
  TItem,
  TReady,
  TResponse extends GithubListResponse,
>({
  attached,
  actions,
  keyOf,
  projectReady,
  describeWriteFailure,
}: {
  /** The keys GitHub says are attached right now — logins, or label names. */
  readonly attached: ReadonlyArray<string>;
  readonly actions: GithubItemPickerActions<TItem, TResponse> | undefined;
  /** The item's identity in `attached`: its login, or its name. */
  readonly keyOf: (item: TItem) => string;
  /** Reads this list's own `ready` rows out of its response. Must be stable across renders — the fetch effect depends on it. */
  readonly projectReady: (response: TResponse) => TReady;
  /** This picker's sentence for a rejected write, ending in a full stop; a `PatchdeskApiError`'s own message is appended to it. */
  readonly describeWriteFailure: (item: TItem, nextAttached: boolean) => string;
}): GithubItemPicker<TItem, TReady> {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [readState, setReadState] = useState<GithubListReadState<TReady>>({
    _tag: "loading",
  });
  const permission: RepositoryLabelPermission =
    readState._tag === "ready" ? readState.permission : "unknown";
  const [pendingAdds, setPendingAdds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingRemoves, setPendingRemoves] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const admittedKeysRef = useRef(new Set<string>());
  const [writeError, setWriteError] = useState<string>();
  // Tracks the last `attached` prop identity rendered, so a change to it can
  // be adjusted for during rendering (the pattern React recommends over an
  // effect for "adjusting state when a prop changes":
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  const [prevAttached, setPrevAttached] = useState(attached);

  const attachedKeys = useMemo(() => new Set(attached), [attached]);
  // Drop each optimistic override once the authoritative attached set catches
  // up with it, so a stale local guess never outlives real data.
  if (prevAttached !== attached) {
    setPrevAttached(attached);
    setPendingAdds((current) =>
      keptKeys(current, (key) => !attachedKeys.has(key)),
    );
    setPendingRemoves((current) =>
      keptKeys(current, (key) => attachedKeys.has(key)),
    );
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // Monotonic request id: a fetch started later always carries a higher id,
  // so an in-flight response from an earlier keystroke is dropped rather
  // than overwriting a newer one that already landed.
  const requestIdRef = useRef(0);
  useEffect(() => {
    if (!open || actions === undefined) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setReadState({ _tag: "loading" });
    actions
      .fetchList(debouncedQuery === "" ? undefined : debouncedQuery)
      .then((response) => {
        if (requestIdRef.current !== requestId) return;
        setReadState(projectReadState(response, projectReady));
      })
      .catch(() => {
        if (requestIdRef.current === requestId)
          setReadState({ _tag: "github_read" });
      });
  }, [open, actions, debouncedQuery, projectReady]);

  const toggle = (item: TItem, nextAttached: boolean): void => {
    const key = keyOf(item);
    if (
      actions === undefined ||
      admittedKeysRef.current.has(key) ||
      permission === "denied"
    )
      return;
    admittedKeysRef.current.add(key);
    setWriteError(undefined);
    setBusyKeys((current) => new Set(current).add(key));
    if (nextAttached) {
      setPendingAdds((current) => new Set(current).add(key));
      setPendingRemoves((current) => withoutMember(current, key));
    } else {
      setPendingRemoves((current) => new Set(current).add(key));
      setPendingAdds((current) => withoutMember(current, key));
    }
    const write = nextAttached ? actions.add(item) : actions.remove(item);
    write
      .catch((cause: unknown) => {
        // The optimistic guess did not hold: revert it.
        if (nextAttached)
          setPendingAdds((current) => withoutMember(current, key));
        else setPendingRemoves((current) => withoutMember(current, key));
        // Permission state is never inferred from this: it already comes from
        // the read path (`readState.permission`). A rejected write here still
        // gets a specific reason surfaced — a permitted account can still hit
        // the ten-assignee cap or an IP allow list — but it does not change
        // what the picker believes about this account's standing.
        const reason =
          cause instanceof PatchdeskApiError ? ` ${cause.message}` : "";
        setWriteError(`${describeWriteFailure(item, nextAttached)}${reason}`);
      })
      .finally(() => {
        admittedKeysRef.current.delete(key);
        setBusyKeys((current) => withoutMember(current, key));
      });
  };

  return {
    open,
    setOpen,
    query,
    setQuery,
    readState,
    permission,
    writeError,
    isAttached: (item) => {
      const key = keyOf(item);
      return (
        pendingAdds.has(key) ||
        (attachedKeys.has(key) && !pendingRemoves.has(key))
      );
    },
    isBusy: (item) => busyKeys.has(keyOf(item)),
    toggle,
  };
}

/** Keeps only the members `keep` accepts, returning the same set when none were dropped so React can skip a re-render it does not need. */
function keptKeys(
  set: ReadonlySet<string>,
  keep: (key: string) => boolean,
): ReadonlySet<string> {
  const next = new Set([...set].filter(keep));
  return next.size === set.size ? set : next;
}
