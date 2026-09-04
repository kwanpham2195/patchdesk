import type { GitHubLabel } from "../../../domain/github-context";
import { Badge } from "./ui/badge";

/** One GitHub label as a neutral outlined pill: the label's real color rides
 * on a dot so the name keeps the app's own foreground contrast in both
 * themes. */
export function LabelChip({
  label,
}: {
  readonly label: GitHubLabel;
}): React.JSX.Element {
  return (
    <Badge
      variant="outline"
      className="h-5 max-w-32 gap-1.5 bg-background px-2 text-[11px] font-medium"
      title={label.name}
    >
      <LabelColorDot color={label.color} />
      <span className="truncate">{label.name}</span>
    </Badge>
  );
}

/** A label's real GitHub colour as a dot. `aria-hidden`: the label's name is
 * its accessible text, here and in the filter list. */
export function LabelColorDot({
  color,
}: {
  readonly color: string;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 rounded-full"
      style={{ backgroundColor: `#${color}` }}
    />
  );
}
