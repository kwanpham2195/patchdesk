/**
 * The read state every GitHub-owned list surface projects from its list
 * response, and the copy for the two specific GitHub read failures it
 * carries: a rate limit (optionally with a resume time) and a forbidden read
 * (with an optional, more specific reason).
 *
 * The three list responses (`RepositoryLabelListResponse`,
 * `AssignableUserListResponse`, `ReviewerListResponse`) differ only in what
 * their `state: "ready"` case carries, so `GithubListReadState` is generic
 * over that payload and `projectReadState` is the one projection all of them
 * run — including the fail-closed `permission ?? "unknown"` rule. Shared by
 * `use-github-item-picker.ts` (which the three rail pickers use),
 * `maintainer-inbox.tsx`'s label filter, and the rail's own
 * `ReviewersSection`, so there is exactly one projection and exactly one
 * wording for each case rather than one per picker. Kept outside any
 * component file so exporting these plain functions never trips
 * `react/only-export-components` (fast refresh expects a component file to
 * only export components).
 */

import type {
  RepositoryLabel,
  RepositoryLabelPermission,
} from "../../domain/github-context";
import type { RepositoryLabelListResponse } from "./renderer-contracts";
import type { ForbiddenReason } from "../../domain/github-forbidden-reason";

/**
 * The fields every GitHub-owned list response carries in common: the read's
 * outcome, and the three fields the non-`ready` outcomes explain themselves
 * with. Each concrete response type adds its own `ready` payload on top.
 */
export type GithubListResponse = {
  readonly state:
    | "ready"
    | "github_auth"
    | "github_read"
    | "github_rate_limited"
    | "github_forbidden";
  readonly permission?: RepositoryLabelPermission | undefined;
  readonly resumeAt?: string | undefined;
  readonly forbiddenReason?: ForbiddenReason | undefined;
};

/**
 * What a GitHub-owned list read resolved to: a list of `TReady`, or a named
 * failure. `TReady` is the rows the surface renders plus whatever it counts
 * them against — labels and a total, assignable people and a total,
 * suggested reviewers plus candidates and a candidate total.
 */
export type GithubListReadState<TReady> =
  | { readonly _tag: "loading" }
  | { readonly _tag: "github_read" }
  | { readonly _tag: "github_auth" }
  | ({
      readonly _tag: "ready";
      /**
       * The service's real, GitHub-evidenced answer for whether this
       * account can write this kind of item here (each list service's
       * `…ListOutcome.ready.permission`). Never inferred client-side —
       * `"unknown"` means evidence was genuinely unavailable, not that a
       * write hasn't been tried yet. Read-only surfaces (the Pull requests
       * screen's label filter) carry it and ignore it.
       */
      readonly permission: RepositoryLabelPermission;
    } & TReady)
  | { readonly _tag: "github_rate_limited"; readonly resumeAt?: string }
  | {
      readonly _tag: "github_forbidden";
      readonly reason?: ForbiddenReason;
    };

/**
 * Projects one GitHub-owned list response into its read state. `projectReady`
 * supplies only the rows the caller's `"ready"` case carries; the permission's
 * fail-closed default and every failure case are decided here, once, for all
 * three list surfaces.
 */
export function projectReadState<TResponse extends GithubListResponse, TReady>(
  response: TResponse | undefined,
  projectReady: (response: TResponse) => TReady,
): GithubListReadState<TReady> {
  if (response === undefined) return { _tag: "github_read" };
  if (response.state === "ready") {
    return {
      _tag: "ready",
      // Fails closed to `"unknown"` (never `"permitted"`) if the field is
      // ever missing — an unconfirmed state, not an authorized one.
      permission: response.permission ?? "unknown",
      ...projectReady(response),
    };
  }
  if (response.state === "github_rate_limited") {
    const resumeAtField =
      response.resumeAt === undefined ? {} : { resumeAt: response.resumeAt };
    return { _tag: "github_rate_limited", ...resumeAtField };
  }
  if (response.state === "github_forbidden") {
    const reasonField =
      response.forbiddenReason === undefined
        ? {}
        : { reason: response.forbiddenReason };
    return { _tag: "github_forbidden", ...reasonField };
  }
  return { _tag: response.state };
}

/** What a repository-label read resolved to: a list, or a named failure. */
export type RepositoryLabelReadState = GithubListReadState<{
  readonly labels: ReadonlyArray<RepositoryLabel>;
  readonly totalCount: number;
}>;

export function projectRepositoryLabelReadState(
  response: RepositoryLabelListResponse | undefined,
): RepositoryLabelReadState {
  return projectReadState(response, (ready) => {
    const labels = ready.labels ?? [];
    return { labels, totalCount: ready.totalCount ?? labels.length };
  });
}

export function rateLimitedCopy(resumeAt: string | undefined): string {
  const resumeAtMs = resumeAt === undefined ? Number.NaN : Date.parse(resumeAt);
  if (Number.isNaN(resumeAtMs))
    return "GitHub rate-limited this account. Try again once the limit clears.";
  const formatted = new Date(resumeAtMs).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `GitHub rate-limited this account. Try again at ${formatted}.`;
}

export function forbiddenCopy(reason: ForbiddenReason | undefined): string {
  switch (reason) {
    case "ip_allow_list":
      return "GitHub blocked this read: an IP allow list is enabled and this network is not on it.";
    case "saml":
      return "GitHub blocked this read: this account's token needs SAML single sign-on authorization.";
    case "insufficient_scopes":
      return "GitHub blocked this read: this account's token lacks the scopes this repository requires.";
    default:
      return "GitHub blocked this read and did not say why.";
  }
}
