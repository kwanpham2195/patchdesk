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
  const [watched, setWatched] = useState<ReadonlySet<string> | undefined>();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<
    ReadonlyMap<string, WatchToggleFailure>
  >(new Map());
  const generation = useRef(0);

  useEffect(() => {
    const owner = ++generation.current;
    setWatched(undefined);
    setFailures(new Map());
    if (profileId === "") return;
    const load = async (): Promise<void> => {
      try {
        const list = readList(
          await requestJson(
            `/v1/watched-pull-requests?profileId=${encodeURIComponent(profileId)}`,
          ),
        );
        if (generation.current === owner) setWatched(new Set(list.map(refKey)));
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
      setFailures((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      try {
        const list = readList(
          await requestJson("/v1/watched-pull-requests", {
            method: watched.has(key) ? "DELETE" : "POST",
            body: { profileId, pullRequest: ref },
          }),
        );
        if (generation.current === owner) setWatched(new Set(list.map(refKey)));
      } catch (cause: unknown) {
        if (generation.current === owner)
          setFailures((current) =>
            new Map(current).set(key, toggleFailure(cause)),
          );
      } finally {
        setPending((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [profileId, watched],
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
          },
    [failures, pending, toggle, watched],
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
