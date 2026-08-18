import type { GitHubLabel } from "../../../domain/github-context";
import { labelForeground } from "../label-color";
import { Badge } from "./ui/badge";

/** One GitHub label rendered with its real color, readable in both themes. */
export function LabelChip({
  label,
}: {
  readonly label: GitHubLabel;
}): React.JSX.Element {
  const background = `#${label.color}`;
  const foreground = labelForeground(label.color);
  return (
    <Badge
      variant="outline"
      className="h-4 max-w-32 truncate px-1.5 text-[10px] font-medium"
      style={{
        backgroundColor: background,
        color: foreground,
        borderColor: "rgba(0,0,0,0.15)",
      }}
      title={label.name}
    >
      {label.name}
    </Badge>
  );
}
