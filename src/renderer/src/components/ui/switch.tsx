import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const switchVariants = cva(
  "peer inline-flex shrink-0 items-center rounded-full border border-transparent bg-input p-px ui-state-transition outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/50 data-checked:bg-primary",
  {
    variants: {
      size: {
        sm: "h-4 w-7",
        default: "h-5 w-9",
      },
    },
    defaultVariants: {
      size: "sm",
    },
  },
);

const switchThumbVariants = cva(
  "pointer-events-none block rounded-full bg-background shadow-sm ui-state-transition data-checked:bg-primary-foreground",
  {
    variants: {
      size: {
        sm: "size-3.5 data-checked:translate-x-3",
        default: "size-4.5 data-checked:translate-x-4",
      },
    },
    defaultVariants: {
      size: "sm",
    },
  },
);

function Switch({
  className,
  size = "sm",
  ...props
}: SwitchPrimitive.Root.Props & VariantProps<typeof switchVariants>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(switchVariants({ size, className }))}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(switchThumbVariants({ size }))}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
