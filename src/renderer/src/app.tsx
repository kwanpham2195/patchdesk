import { DashboardEmptyState } from "@/components/dashboard-empty-state";

/** Renders the deliberately empty first-run Patchdesk workbench. */
export function App(): React.JSX.Element {
  return (
    <main className="min-h-screen bg-slate-950 px-8 py-10 text-slate-100">
      <div className="mx-auto max-w-3xl">
        <DashboardEmptyState />
      </div>
    </main>
  );
}
