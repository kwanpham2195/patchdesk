/**
 * Closed set of reasons GitHub can refuse a request as forbidden. Kept
 * small and closed deliberately: the renderer receives a member of this
 * enum, never GitHub's raw message text (see plan 009's Why This Matters —
 * GitHubReadFailure never leaks stdout/stderr to the renderer, and this
 * type preserves that property for forbidden reads and writes alike).
 *
 * Lives in the domain layer, not `command-runner.ts`, so that
 * `GitHubWriteFailure` (`./github-write.ts`) can carry it without a
 * domain -> adapter import; `command-runner.ts` re-exports this type for
 * its existing importers.
 */
export const FORBIDDEN_REASONS = [
  "ip_allow_list",
  "saml",
  "insufficient_scopes",
  "unknown",
] as const;

export type ForbiddenReason = (typeof FORBIDDEN_REASONS)[number];
