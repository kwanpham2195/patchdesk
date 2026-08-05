import * as React from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronDown } from "lucide-react";

export type ModelComboboxOption = {
  readonly id: string;
  readonly label: string;
};

/** A searchable, renderer-safe picker for the enabled model catalog. */
export function ModelCombobox({
  id,
  ariaLabel,
  options,
  value,
  onValueChange,
  disabled = false,
  placeholder = "Choose a model",
}: {
  readonly id?: string;
  readonly ariaLabel: string;
  readonly options: ReadonlyArray<ModelComboboxOption>;
  readonly value: string | null;
  readonly onValueChange: (value: string | null) => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
}): React.JSX.Element {
  const selected = options.find((option) => option.id === value) ??
    (value === null ? null : { id: value, label: value });
  const isDisabled = disabled || options.length === 0;

  return (
    <Combobox.Root
      items={options}
      value={selected}
      disabled={isDisabled}
      itemToStringLabel={(option: ModelComboboxOption) => option.label}
      itemToStringValue={(option: ModelComboboxOption) => option.id}
      isItemEqualToValue={(left: ModelComboboxOption, right: ModelComboboxOption) => left.id === right.id}
      filter={(option: ModelComboboxOption, query: string) => {
        const normalized = query.toLowerCase();
        return option.label.toLowerCase().includes(normalized) || option.id.toLowerCase().includes(normalized);
      }}
      onValueChange={(next) => onValueChange(next?.id ?? null)}
    >
      <Combobox.InputGroup className="relative h-8 w-full rounded-lg border border-input bg-transparent focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
        <Combobox.Input
          id={id}
          aria-label={ariaLabel}
          placeholder={isDisabled && options.length === 0 ? "No enabled model available" : placeholder}
          className="h-full w-full min-w-0 rounded-lg border-0 bg-transparent px-2.5 py-1 pr-8 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50"
        />
        <Combobox.Trigger
          aria-label={`Open ${ariaLabel.toLowerCase()} options`}
          className="absolute inset-y-0 right-0 flex w-8 items-center justify-center rounded-r-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
        >
          <ChevronDown className="size-4" aria-hidden="true" />
        </Combobox.Trigger>
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner className="z-50 outline-none" sideOffset={4}>
          <Combobox.Popup data-slot="model-combobox-content" className="w-[var(--anchor-width)] max-w-[var(--available-width)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md">
            <Combobox.Empty className="px-3 py-4 text-center text-sm text-muted-foreground">
              No models found.
            </Combobox.Empty>
            <Combobox.List className="max-h-72 overflow-y-auto overscroll-contain p-1 outline-none">
              {(option: ModelComboboxOption) => (
                <Combobox.Item
                  key={option.id}
                  value={option}
                  className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  <Combobox.ItemIndicator className="flex size-4 shrink-0 items-center justify-center">
                    <Check className="size-4" aria-hidden="true" />
                  </Combobox.ItemIndicator>
                  <span className="min-w-0 truncate">{option.label}</span>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
