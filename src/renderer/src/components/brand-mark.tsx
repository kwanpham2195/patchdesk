import { cn } from "@/lib/utils";
import logoUrl from "#resources/branding/patchdesk-logo.svg?url";

export function BrandMark({
  size = 32,
  className,
}: {
  readonly size?: number;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      className={cn("shrink-0 rounded-[22%]", className)}
    />
  );
}
