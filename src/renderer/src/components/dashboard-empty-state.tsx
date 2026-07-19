import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

/** Renders the useful empty state before a pull request is selected. */
export function DashboardEmptyState(): React.JSX.Element {
  return (
    <Empty className="min-h-72 border-border bg-card">
      <EmptyHeader>
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
          Local pull request review
        </p>
        <EmptyTitle className="text-[28px] font-semibold tracking-[-0.5px]">
          Patchdesk
        </EmptyTitle>
        <EmptyDescription className="text-sm">
          Open a pull request to begin a local review.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
