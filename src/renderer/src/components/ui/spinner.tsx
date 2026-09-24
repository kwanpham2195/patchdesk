import { cn } from "@/lib/utils";

// Ring geometry adapted from loading.dev's Ring (MIT, (c) 2026 Jakub Krehel).
function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg
      role="status"
      aria-label="Loading"
      viewBox="0 0 24 24"
      fill="none"
      className={cn("size-4 animate-spin", className)}
      {...props}
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2.5"
        opacity="0.2"
      />
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeDasharray="16 46.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export { Spinner };
