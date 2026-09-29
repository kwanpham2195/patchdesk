import * as v from "valibot";

import type { RepositoryIdentity } from "../../domain/repository-identity";
import type { LocalReviewSourceInput } from "./flows/use-inbox-review-opening";

const branchName = v.pipe(v.string(), v.minLength(1));

// `GET /v1/reviews/local-branches` (#555): the bases a shared Review can take, local and remote-tracking (#591), and the one inferred.
const localBranchesSchema = v.strictObject({
  head: v.variant("kind", [
    v.strictObject({ kind: v.literal("branch"), branch: branchName }),
    v.strictObject({ kind: v.literal("detached") }),
  ]),
  branches: v.array(branchName),
  remoteBranches: v.array(branchName),
  defaultBranch: v.optional(branchName),
  inferred: v.optional(
    v.strictObject({
      baseBranch: branchName,
      commitsBack: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
  ),
  // Full refs, the one opened last first.
  reviewedBases: v.array(branchName),
});

export type LocalBranches = v.InferOutput<typeof localBranchesSchema>;

export function parseLocalBranches(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the boundary parser for the listing's raw JSON body.
  value: unknown,
): LocalBranches | undefined {
  const parsed = v.safeParse(localBranchesSchema, value);
  return parsed.success ? parsed.output : undefined;
}

/** The listing for `checkout`, or for the configured checkout when it is absent. */
export function localBranchesPath(
  profileId: string,
  repository: RepositoryIdentity,
  checkout: string | undefined,
): string {
  const query = new URLSearchParams({ profileId, ...repository });
  if (checkout !== undefined) query.set("checkout", checkout);
  return `/v1/reviews/local-branches?${query.toString()}`;
}

/** Why a base is preselected: "nearest branch: main, 3 commits back". */
export function inferredBaseReason(
  inferred: NonNullable<LocalBranches["inferred"]>,
): string {
  const commits = inferred.commitsBack === 1 ? "commit" : "commits";
  return `nearest branch: ${inferred.baseBranch}, ${String(inferred.commitsBack)} ${commits} back`;
}

/** The ref of the base inference picked; inference names local branches only. */
export function inferredBaseRef(
  inferred: NonNullable<LocalBranches["inferred"]>,
): string {
  return `refs/heads/${inferred.baseBranch}`;
}

/** A base the picker offers: its full ref, and the name it shows. */
export type BaseRefOption = { readonly ref: string; readonly name: string };

/** One heading of the base picker with its bases. */
export type BaseRefGroup = {
  readonly value: "Local branches" | "Remote branches";
  readonly items: ReadonlyArray<BaseRefOption>;
};

/** The picker's bases (#591): local branches, then remote-tracking ones, each group left out when empty. */
export function baseRefGroups(
  listing: LocalBranches,
): ReadonlyArray<BaseRefGroup> {
  const groups: ReadonlyArray<BaseRefGroup> = [
    {
      value: "Local branches",
      items: listing.branches.map((name) => ({
        ref: `refs/heads/${name}`,
        name,
      })),
    },
    {
      value: "Remote branches",
      items: listing.remoteBranches.map((name) => ({
        ref: `refs/remotes/${name}`,
        name,
      })),
    },
  ];
  return groups.filter((group) => group.items.length > 0);
}

/** The open of the shared Review of the branch `head` names against `baseRef`; a branch switch since the listing is refused. */
export function sharedReviewSource(
  baseRef: string,
  head: LocalBranches["head"],
  checkout: string | undefined,
): LocalReviewSourceInput {
  return checkout === undefined
    ? { kind: "local_branch", baseRef, expectedHead: head }
    : { kind: "local_branch", baseRef, expectedHead: head, checkout };
}
