import { Button } from "@/components/ui/button";

/** A kept inline draft waiting for a new diff line (#526). */
export type DraftRecovery = {
  readonly message: string;
  readonly onDismiss: () => void;
};

/** Sits above the diff, because the lines the draft was written on are gone. */
export function DraftRecoveryPrompt({
  recovery,
}: {
  readonly recovery: DraftRecovery | undefined;
}): React.JSX.Element | null {
  if (recovery === undefined) return null;
  return (
    <section
      aria-label="Saved draft"
      className="mx-2 my-2 flex items-center gap-3 rounded-md border bg-card p-3 font-sans text-sm shadow-sm"
    >
      <p className="min-w-0 flex-1">{recovery.message}</p>
      <Button size="sm" variant="outline" onClick={recovery.onDismiss}>
        Dismiss draft
      </Button>
    </section>
  );
}
