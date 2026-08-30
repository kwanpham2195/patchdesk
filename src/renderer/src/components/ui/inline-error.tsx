import * as React from "react";

import { cn } from "@/lib/utils";

/** Presents an action-local error without owning its spacing or behavior. */
function InlineError({
  className,
  ...props
}: React.ComponentProps<"p">): React.JSX.Element {
  return (
    <p
      {...props}
      data-slot="inline-error"
      role="alert"
      className={cn("text-sm text-destructive", className)}
    />
  );
}

export { InlineError };
