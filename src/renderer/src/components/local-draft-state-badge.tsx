import type { LocalDraftEntry } from "../local-draft-contracts";
import { Badge } from "./ui/badge";

type LocalDraftState = NonNullable<LocalDraftEntry["state"]>;

const LABELS = {
  unchanged: "Unchanged",
  changed: "Changed since your note",
  needs_attention: "Needs attention",
  applied: "Applied in Patchdesk",
} satisfies Record<LocalDraftState, string>;

const VARIANTS = {
  unchanged: "outline",
  changed: "secondary",
  needs_attention: "warning",
  applied: "success",
} as const satisfies Record<LocalDraftState, string>;

/** What the last Refresh or Apply decided for one Local draft (#452); nothing before the first one. */
export function LocalDraftStateBadge({
  state,
}: {
  readonly state: LocalDraftEntry["state"];
}): React.JSX.Element | null {
  if (state === undefined) return null;
  return <Badge variant={VARIANTS[state]}>{LABELS[state]}</Badge>;
}
