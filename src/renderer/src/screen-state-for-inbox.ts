import type { InboxResponse } from "./renderer-contracts";
import type { Dashboard, DashboardScreenState } from "./renderer-models";

/**
 * Decides the whole Pull requests screen's state from the inbox and
 * dashboard `app.tsx` just loaded. A plain function rather than inline in
 * `app.tsx` so it can be exercised directly in
 * `tests/renderer/screen-state-for-inbox.test.ts` — `Outcome`
 * (`flows/inbox-flow.tsx`) renders "success" and "no_open_prs" identically,
 * so no rendered-UI assertion can tell those two branches apart.
 */
export function screenStateForInbox(
  inbox: InboxResponse,
  dashboard: Dashboard,
): DashboardScreenState {
  const outcomes = dashboard.dashboard.repos.map((item) => item.state);
  if (
    outcomes.includes("github_auth") ||
    outcomes.includes("github_read") ||
    outcomes.includes("github_rate_limited") ||
    outcomes.includes("github_forbidden")
  )
    return "error";
  if (
    inbox.inbox.state === "open" &&
    outcomes.includes("no_open_prs") &&
    inbox.inbox.rows.length === 0
  )
    return "no_open_prs";
  return inbox.inbox.rows.length === 0 ? "empty" : "success";
}
