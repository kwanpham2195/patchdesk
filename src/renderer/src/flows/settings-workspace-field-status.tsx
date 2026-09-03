import { FieldDescription, FieldError } from "../components/ui/field";
import type { FieldStatus } from "./settings-workspace-profile-editor";

/**
 * One Workspace control's own save result, rendered beside it: every control
 * in Settings > Workspace saves on its own, so each one says whether it is
 * saving, saved, or failed rather than a single card-level banner doing it.
 */
export function FieldSaveStatus({
  status,
}: {
  readonly status: FieldStatus;
}): React.JSX.Element | null {
  if (status.state === "idle") return null;
  if (status.state === "failed")
    return <FieldError>{status.message}</FieldError>;
  return (
    <FieldDescription className="text-xs" role="status">
      {status.state === "saving" ? "Saving…" : "Saved"}
    </FieldDescription>
  );
}
