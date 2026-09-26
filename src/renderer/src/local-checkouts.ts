import * as v from "valibot";

import type { RepositoryIdentity } from "../../domain/repository-identity";

// `GET /v1/reviews/local-checkouts` (#489): the configured checkout and its live linked worktrees.
const localCheckoutsSchema = v.array(
  v.strictObject({
    path: v.pipe(v.string(), v.minLength(1)),
    name: v.pipe(v.string(), v.minLength(1)),
    head: v.variant("kind", [
      v.strictObject({
        kind: v.literal("branch"),
        branch: v.pipe(v.string(), v.minLength(1)),
      }),
      v.strictObject({ kind: v.literal("detached") }),
    ]),
    configured: v.boolean(),
  }),
);

export type LocalCheckout = v.InferOutput<typeof localCheckoutsSchema>[number];

export function parseLocalCheckouts(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the boundary parser for the listing's raw JSON body.
  value: unknown,
): ReadonlyArray<LocalCheckout> | undefined {
  const parsed = v.safeParse(localCheckoutsSchema, value);
  return parsed.success ? parsed.output : undefined;
}

export function localCheckoutsPath(
  profileId: string,
  repository: RepositoryIdentity,
): string {
  const query = new URLSearchParams({ profileId, ...repository });
  return `/v1/reviews/local-checkouts?${query.toString()}`;
}
