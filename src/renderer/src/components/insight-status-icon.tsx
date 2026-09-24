import { Check, CircleDashed, CircleX, History } from "lucide-react";

import { Spinner } from "./ui/spinner";
import type { InsightStatus } from "../insight-status";
import { cn } from "@/lib/utils";

/** Outdated evidence is still readable, so it reads amber; only Failed reads red. */
export function InsightStatusIcon({
  status,
  className,
}: {
  readonly status: InsightStatus;
  readonly className?: string;
}): React.JSX.Element {
  const iconClass = cn("size-3 shrink-0", className);
  switch (status) {
    case "running":
      return <Spinner aria-hidden="true" className={iconClass} />;
    case "current":
      return (
        <Check
          aria-hidden="true"
          className={cn(iconClass, "text-status-success")}
        />
      );
    case "outdated":
      return (
        <History
          aria-hidden="true"
          className={cn(iconClass, "text-status-warning")}
        />
      );
    case "failed":
      return (
        <CircleX
          aria-hidden="true"
          className={cn(iconClass, "text-destructive")}
        />
      );
    case "not_generated":
      return (
        <CircleDashed
          aria-hidden="true"
          className={cn(iconClass, "text-muted-foreground")}
        />
      );
  }
}
