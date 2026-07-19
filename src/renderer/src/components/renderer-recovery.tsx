import { Button } from "@/components/ui/button";

export function RendererRecovery({ onReload }: { readonly onReload: () => void }): React.JSX.Element {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
      <section className="max-w-lg rounded-xl border bg-card p-6 shadow-sm">
        <p className="text-sm font-medium text-primary">Patchdesk recovery</p>
        <h1 className="mt-2 text-2xl font-semibold">The workbench could not render safely.</h1>
        <p className="mt-2 text-sm text-muted-foreground">Your persisted review state was not changed. Reload Patchdesk to reopen the last saved destination; no GitHub write will be retried.</p>
        <Button className="mt-4" onClick={onReload}>Reload Patchdesk</Button>
      </section>
    </main>
  );
}
