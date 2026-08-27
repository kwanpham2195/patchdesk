/**
 * The read state every repository-label surface projects from a
 * `RepositoryLabelListResponse`, and the copy for the two specific GitHub
 * read failures it carries: a rate limit (optionally with a resume time) and
 * a forbidden read (with an optional, more specific reason). Shared by
 * `label-picker.tsx`, `maintainer-inbox.tsx`'s label filter,
 * `assignee-picker.tsx`, `reviewer-picker.tsx`, and the rail's own
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

/** What a repository-label read resolved to: a list, or a named failure. */
export type RepositoryLabelReadState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "github_read" }
  | { readonly _tag: "github_auth" }
  | {
      readonly _tag: "ready";
      readonly labels: ReadonlyArray<RepositoryLabel>;
      readonly totalCount: number;
      /**
       * The service's real, GitHub-evidenced answer for whether this
       * account can write labels here (`LabelListOutcome.ready.permission`
       * in `src/services/label-service.ts`). Never inferred client-side —
       * `"unknown"` means evidence was genuinely unavailable, not that a
       * write hasn't been tried yet. Read-only surfaces (the Pull requests
       * screen's label filter) carry it and ignore it.
       */
      readonly permission: RepositoryLabelPermission;
    }
  | { readonly _tag: "github_rate_limited"; readonly resumeAt?: string }
  | {
      readonly _tag: "github_forbidden";
      readonly reason?: ForbiddenReason;
    };

export function projectRepositoryLabelReadState(
  response: RepositoryLabelListResponse | undefined,
): RepositoryLabelReadState {
  if (response === undefined) return { _tag: "github_read" };
  if (response.state === "ready") {
    const labels = response.labels ?? [];
    return {
      _tag: "ready",
      labels,
      totalCount: response.totalCount ?? labels.length,
      // Fails closed to `"unknown"` (never `"permitted"`) if the field is
      // ever missing — an unconfirmed state, not an authorized one.
      permission: response.permission ?? "unknown",
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
