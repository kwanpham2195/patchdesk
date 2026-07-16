import { Card } from "@/components/ui/card";

/** Renders the useful empty state before a pull request is selected. */
export function DashboardEmptyState(): React.JSX.Element {
  return (
    <Card>
      <p className="text-sm font-medium uppercase tracking-[0.2em] text-cyan-300">
        Local pull request review
      </p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight">Patchdesk</h1>
      <p className="mt-4 text-lg text-slate-300">
        Open a pull request to begin a local review.
      </p>
    </Card>
  );
}
