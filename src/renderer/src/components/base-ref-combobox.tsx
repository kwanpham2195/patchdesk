import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronDown } from "lucide-react";

import type { BaseRefGroup, BaseRefOption } from "../local-branches";

/**
 * The shared Review's base picker (#591): one search over local and
 * remote-tracking branches, each shown under its group, so `main` finds both
 * `main` and `origin/main`.
 */
export function BaseRefCombobox({
  id,
  groups,
  value,
  onValueChange,
}: {
  readonly id: string;
  readonly groups: ReadonlyArray<BaseRefGroup>;
  /** The picked base's full ref. */
  readonly value: string | undefined;
  readonly onValueChange: (ref: string) => void;
}): React.JSX.Element {
  const selected =
    groups
      .flatMap((group) => group.items)
      .find((option) => option.ref === value) ?? null;
  return (
    <Combobox.Root
      items={groups}
      value={selected}
      itemToStringLabel={(option: BaseRefOption) => option.name}
      itemToStringValue={(option: BaseRefOption) => option.ref}
      isItemEqualToValue={(left: BaseRefOption, right: BaseRefOption) =>
        left.ref === right.ref
      }
      onValueChange={(next: BaseRefOption | null) => {
        if (next !== null) onValueChange(next.ref);
      }}
    >
      <Combobox.InputGroup className="relative h-8 w-full rounded-lg border border-input bg-transparent focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
        <Combobox.Input
          id={id}
          aria-label="Base branch"
          placeholder="Search branches"
          className="h-full w-full min-w-0 rounded-lg border-0 bg-transparent px-2.5 py-1 pr-8 text-sm outline-none placeholder:text-muted-foreground"
        />
        <Combobox.Trigger
          aria-label="Open base branch options"
          className="absolute inset-y-0 right-0 flex w-8 items-center justify-center rounded-r-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown className="size-4" aria-hidden="true" />
        </Combobox.Trigger>
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner className="z-50 outline-none" sideOffset={4}>
          <Combobox.Popup className="w-[var(--anchor-width)] max-w-[var(--available-width)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md">
            <Combobox.Empty className="px-3 py-4 text-center empty:p-0 text-sm text-muted-foreground">
              No branches match.
            </Combobox.Empty>
            <Combobox.List className="max-h-72 overflow-y-auto overscroll-contain p-1 outline-none">
              {(group: BaseRefGroup) => (
                <Combobox.Group key={group.value} items={group.items}>
                  <Combobox.GroupLabel className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                    {group.value}
                  </Combobox.GroupLabel>
                  <Combobox.Collection>
                    {(option: BaseRefOption) => (
                      <Combobox.Item
                        key={option.ref}
                        value={option}
                        className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                      >
                        <Combobox.ItemIndicator className="flex size-4 shrink-0 items-center justify-center">
                          <Check className="size-4" aria-hidden="true" />
                        </Combobox.ItemIndicator>
                        <span className="min-w-0 truncate">{option.name}</span>
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
