/**
 * Copy for the two specific GitHub read failures every metadata picker's
 * `ReadState` carries: a rate limit (optionally with a resume time) and a
 * forbidden read (with an optional, more specific reason). Shared by
 * `assignee-picker.tsx`, `reviewer-picker.tsx`, and the rail's own
 * `ReviewersSection` read-failure copy, so there is exactly one wording for
 * each case rather than one per picker. Kept outside any component file so
 * exporting these plain functions never trips `react/only-export-components`
 * (fast refresh expects a component file to only export components).
 */

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

export function forbiddenCopy(
  reason:
    | "ip_allow_list"
    | "saml"
    | "insufficient_scopes"
    | "unknown"
    | undefined,
): string {
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
