import type { InboxView } from "./renderer-contracts";

export const inboxQueues: ReadonlyArray<{
  readonly id: InboxView;
  readonly label: string;
  readonly category?: string;
}> = [
  { id: "my_inbox", label: "My inbox" },
  { id: "updated", label: "Updated", category: "updated_since_review" },
  { id: "needs_review", label: "Needs review", category: "needs_review" },
  { id: "waiting", label: "Waiting", category: "waiting_for_author" },
  { id: "checks_failing", label: "Checks failing", category: "checks_failing" },
  { id: "ready_to_merge", label: "Ready to merge", category: "ready_to_merge" },
  { id: "all_open", label: "All open" },
];
