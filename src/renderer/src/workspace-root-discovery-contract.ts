import * as v from "valibot";

const discoveredRepoSchema = v.strictObject({
  host: v.pipe(v.string(), v.minLength(1)),
  owner: v.pipe(v.string(), v.minLength(1)),
  repo: v.pipe(v.string(), v.minLength(1)),
  localPath: v.pipe(v.string(), v.minLength(1)),
});

const workspaceRootDiscoverySchema = v.variant("state", [
  v.strictObject({
    root: v.pipe(v.string(), v.minLength(1)),
    state: v.literal("ready"),
    repositories: v.array(discoveredRepoSchema),
  }),
  v.strictObject({
    root: v.pipe(v.string(), v.minLength(1)),
    state: v.literal("failed"),
    reason: v.literal("scan_failed"),
  }),
]);

/** A repository discovered beneath a saved workspace root. */
export type DiscoveredRepo = v.InferOutput<typeof discoveredRepoSchema>;

/** The bounded discovery outcome for one saved workspace root. */
export type WorkspaceRootDiscovery = v.InferOutput<
  typeof workspaceRootDiscoverySchema
>;

/** Parses `GET /v1/watchlist/suggestions` per-root discovery outcomes. */
export function parseWorkspaceRootDiscoveries(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this function is itself the JSON I/O boundary parser; there is no earlier boundary to run it at.
  input: unknown,
): ReadonlyArray<WorkspaceRootDiscovery> | undefined {
  const parsed = v.safeParse(v.array(workspaceRootDiscoverySchema), input);
  return parsed.success ? parsed.output : undefined;
}

/** Flattens repositories from ready root outcomes for the watchlist checklist. */
export function flattenDiscoveredRepositories(
  discoveries: ReadonlyArray<WorkspaceRootDiscovery>,
): ReadonlyArray<DiscoveredRepo> {
  return discoveries.flatMap((discovery) =>
    discovery.state === "ready" ? discovery.repositories : [],
  );
}
