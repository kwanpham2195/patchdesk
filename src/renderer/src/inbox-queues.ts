import type { InboxView } from "./renderer-contracts";

export const inboxQueues: ReadonlyArray<{
  readonly id: InboxView;
  readonly label: string;
  readonly category?: string;
}> = [
  { id: "my_inbox", label: "My inbox" },
  { id: "updated", label: "Updated", category: "updated_since_review" },
  { id: "ready_to_merge", label: "Ready to merge", category: "ready_to_merge" },
  { id: "all_open", label: "All open" },
];
