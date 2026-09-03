import { FolderOpen, Plus, X } from "lucide-react";
import { Button } from "../components/ui/button";
import {
  FieldDescription,
  FieldLegend,
  FieldSet,
} from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import type { FieldStatus } from "./settings-workspace-profile-editor";
import type {
  ProfileListEntry,
  ProfileListField,
} from "./settings-workspace-profile-values";
import { FieldSaveStatus } from "./settings-workspace-field-status";

/**
 * The row editor behind both list-valued Workspace controls (folders and rule
 * paths). Its own module so the Workspace cards can be shared with the
 * Pull requests first-run flow without either card file carrying it.
 */
export function ProfileListEditor({
  label,
  itemLabel,
  description,
  field,
  entries,
  placeholder,
  status,
  onChange,
  onCommit,
  onAdd,
  onRemove,
  onChoose,
  renderStatus,
}: {
  readonly label: string;
  /** What one row is called, capitalised: names each row and its buttons. */
  readonly itemLabel: string;
  readonly description?: string;
  readonly field: ProfileListField;
  readonly entries: ReadonlyArray<ProfileListEntry>;
  readonly placeholder: string;
  readonly status: FieldStatus;
  readonly onChange: (
    field: ProfileListField,
    entryId: string,
    value: string,
  ) => void;
  readonly onCommit: (field: ProfileListField) => void;
  readonly onAdd: (field: ProfileListField) => void;
  readonly onRemove: (field: ProfileListField, entryId: string) => void;
  readonly onChoose?: (entryId: string) => void;
  readonly renderStatus?: (value: string) => React.ReactNode;
}): React.JSX.Element {
  const singular = itemLabel.toLowerCase();
  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label">{label}</FieldLegend>
      {description === undefined ? null : (
        <FieldDescription>{description}</FieldDescription>
      )}
      <div className="flex flex-col gap-2 rounded-lg border p-2">
        {entries.map((entry, index) => (
          <div key={entry.id} className="flex flex-col gap-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <Input
                aria-label={`${itemLabel} ${index + 1}`}
                value={entry.value}
                placeholder={placeholder}
                onChange={(event) =>
                  onChange(field, entry.id, event.target.value)
                }
                onBlur={() => onCommit(field)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onCommit(field);
                }}
              />
              {onChoose === undefined ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onChoose(entry.id)}
                >
                  <FolderOpen data-icon="inline-start" />
                  Choose folder
                </Button>
              )}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="outline"
                      aria-label={`Remove ${singular} ${index + 1}`}
                      onClick={() => onRemove(field, entry.id)}
                    />
                  }
                >
                  <X />
                </TooltipTrigger>
                <TooltipContent>{`Remove ${singular}`}</TooltipContent>
              </Tooltip>
            </div>
            {renderStatus === undefined || entry.value.trim() === ""
              ? null
              : renderStatus(entry.value)}
          </div>
        ))}
      </div>
      <FieldSaveStatus status={status} />
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onAdd(field)}
        className="w-fit"
      >
        <Plus data-icon="inline-start" />
        {`Add ${singular}`}
      </Button>
    </FieldSet>
  );
}
