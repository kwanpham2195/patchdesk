import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as v from "valibot";

import { PatchdeskApiError, requestJson } from "../api-client";

/** A pull request as the renderer names it: plain strings, as every local API payload carries. */
export type WatchedPullRequestRef = {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
};

/** Why the last Watch or Unwatch of one pull request did not apply. */
export type WatchToggleFailure =
  | { readonly kind: "limit"; readonly limit: number }
  | { readonly kind: "failed" };

type WatchedPullRequestsValue = {
  readonly isWatched: (ref: WatchedPullRequestRef) => boolean;
  readonly isPending: (ref: WatchedPullRequestRef) => boolean;
  readonly failureFor: (
    ref: WatchedPullRequestRef,
  ) => WatchToggleFailure | undefined;
  readonly toggle: (ref: WatchedPullRequestRef) => Promise<void>;
  /** When this window last heard that a poll found a change for the profile; the freshness badge compares it with its refresh. */
  readonly changedAt: string | undefined;
};

const WatchedPullRequestsContext =
  createContext<WatchedPullRequestsValue | null>(null);

const refSchema = v.strictObject({
  host: v.pipe(v.string(), v.minLength(1)),
  owner: v.pipe(v.string(), v.minLength(1)),
  repo: v.pipe(v.string(), v.minLength(1)),
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
const listResponseSchema = v.strictObject({
  pullRequests: v.array(refSchema),
});
const limitFailureSchema = v.strictObject({
  error: v.strictObject({
    _tag: v.literal("WatchLimitReached"),
    limit: v.number(),
  }),
});

/** A value and the workspace profile it was read for. */
type ProfileScoped<Value> = {
  readonly profileId: string;
  readonly value: Value;
};

const noFailures: ReadonlyMap<string, WatchToggleFailure> = new Map();

function refKey(ref: WatchedPullRequestRef): string {
  return `${ref.host}/${ref.owner}/${ref.repo}#${ref.number}`;
}

function readList(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- parses the local API's watched list response at the renderer boundary.
  body: unknown,
): ReadonlyArray<WatchedPullRequestRef> {
  const parsed = v.safeParse(listResponseSchema, body);
  if (!parsed.success) throw new Error("invalid watched pull requests");
  return parsed.output.pullRequests;
}

function toggleFailure(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a `catch` binding is `unknown` by construction.
  cause: unknown,
): WatchToggleFailure {
  if (!(cause instanceof PatchdeskApiError)) return { kind: "failed" };
  const limit = v.safeParse(limitFailureSchema, cause.responseBody);
  return limit.success
    ? { kind: "limit", limit: limit.output.error.limit }
    : { kind: "failed" };
}

/**
 * Loads the active profile's watched pull requests (ADR 0045) and shares the
 * Watch toggle with every surface that offers it, so the Pull requests
 * inspector, the Review header, the palette, and the visited column agree.
 */
export function WatchedPullRequestsProvider({
  profileId,
  children,
}: {
  /** Empty while no workspace is loaded; nothing is read and every toggle is hidden. */
  readonly profileId: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  // Each piece of state names the profile it belongs to, so a workspace switch hides the previous one without an effect resetting it.
  const [loaded, setLoaded] = useState<ProfileScoped<ReadonlySet<string>>>();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [failureState, setFailureState] =
    useState<ProfileScoped<ReadonlyMap<string, WatchToggleFailure>>>();
  const [changed, setChanged] = useState<ProfileScoped<string>>();
  const generation = useRef(0);
  const watched = loaded?.profileId === profileId ? loaded.value : undefined;
  const failures =
    failureState?.profileId === profileId ? failureState.value : noFailures;
  const changedAt =
    changed?.profileId === profileId ? changed.value : undefined;

  useEffect(() => {
    if (profileId === "" || window.patchdesk === undefined) return;
    return window.patchdesk.onWatchedPullRequestChange((changedProfileId) => {
      if (changedProfileId === profileId)
        setChanged({ profileId, value: new Date().toISOString() });
    });
  }, [profileId]);

  useEffect(() => {
    const owner = ++generation.current;
    if (profileId === "") return;
    const load = async (): Promise<void> => {
      try {
        const list = readList(
          await requestJson(
            `/v1/watched-pull-requests?profileId=${encodeURIComponent(profileId)}`,
          ),
        );
        if (generation.current === owner)
          setLoaded({ profileId, value: new Set(list.map(refKey)) });
      } catch {
        // An unreadable list hides the toggles rather than showing every pull request as unwatched.
      }
    };
    void load();
  }, [profileId]);

  const toggle = useCallback(
    async (ref: WatchedPullRequestRef): Promise<void> => {
      if (watched === undefined) return;
      const key = refKey(ref);
      const owner = generation.current;
      setPending((current) => new Set(current).add(key));
      const withoutFailure = new Map(failures);
      withoutFailure.delete(key);
      setFailureState({ profileId, value: withoutFailure });
      try {
        const list = readList(
          await requestJson("/v1/watched-pull-requests", {
            method: watched.has(key) ? "DELETE" : "POST",
            body: { profileId, pullRequest: ref },
          }),
        );
        if (generation.current === owner)
          setLoaded({ profileId, value: new Set(list.map(refKey)) });
      } catch (cause: unknown) {
        if (generation.current === owner)
          setFailureState({
            profileId,
            value: new Map(withoutFailure).set(key, toggleFailure(cause)),
          });
      } finally {
        setPending((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [failures, profileId, watched],
  );

  const value = useMemo<WatchedPullRequestsValue | null>(
    () =>
      watched === undefined
        ? null
        : {
            isWatched: (ref) => watched.has(refKey(ref)),
            isPending: (ref) => pending.has(refKey(ref)),
            failureFor: (ref) => failures.get(refKey(ref)),
            toggle,
            changedAt,
          },
    [changedAt, failures, pending, toggle, watched],
  );
  return (
    <WatchedPullRequestsContext.Provider value={value}>
      {children}
    </WatchedPullRequestsContext.Provider>
  );
}

/** The shared Watch state, or `undefined` outside a loaded workspace, where no surface offers the toggle. */
// oxlint-disable-next-line react/only-export-components -- The context hook lives with its provider so consumers import both from one module.
export function useWatchedPullRequests(): WatchedPullRequestsValue | undefined {
  return useContext(WatchedPullRequestsContext) ?? undefined;
}
