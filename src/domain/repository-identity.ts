/**
 * One repository's identity — the `{host, owner, repo}` triple every layer
 * names a repository by — and the one equality check over it.
 *
 * Two shapes of this triple exist on purpose, and they are not
 * interchangeable:
 *
 * - The main process holds it with branded identity types
 *   (`WatchedRepoRef`, `InboxRepositoryRef`), because it is the side that
 *   parses and validates GitHub identifiers.
 * - The renderer holds it as plain strings (`RepositoryIdentity` below,
 *   and `Repo`, which adds the maintainer's optional local checkout path),
 *   because nothing crossing the local HTTP API or `localStorage` carries a
 *   brand — a brand cannot survive JSON.
 *
 * `sameRepositoryIdentity` is structural, so it compares either shape, and
 * it is the only implementation of this comparison in the codebase. Before
 * it, five copies of the same three-field `&&` chain existed independently.
 */

/** A repository named by plain strings: what crosses the local HTTP API,
 * `localStorage`, and every renderer prop. The main process's branded
 * `WatchedRepoRef` and `InboxRepositoryRef` are assignable to this. */
export type RepositoryIdentity = {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
};

/**
 * True when both references name the same repository. Tolerates `undefined`
 * on either side — two absent repositories are the same absence, and an
 * absent one never matches a present one — because the renderer compares a
 * stored preference against a watchlist that may be empty.
 */
export function sameRepositoryIdentity(
  left: RepositoryIdentity | undefined,
  right: RepositoryIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.host === right.host &&
    left.owner === right.owner &&
    left.repo === right.repo
  );
}
