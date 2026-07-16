import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** Renders the shadcn-compatible surface used by Patchdesk dashboard states. */
export function Card({
  className,
  ...properties
}: ComponentProps<"section">): React.JSX.Element {
  return (
    <section
      className={cn(
        "rounded-xl border border-slate-800 bg-slate-900 p-8 shadow-2xl",
        className,
      )}
      {...properties}
    />
  );
}
