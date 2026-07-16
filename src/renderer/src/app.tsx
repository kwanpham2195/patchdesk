/** Renders the deliberately empty first-run Patchdesk workbench. */
export function App(): React.JSX.Element {
  return (
    <main className="min-h-screen bg-slate-950 px-8 py-10 text-slate-100">
      <section className="mx-auto max-w-3xl rounded-xl border border-slate-800 bg-slate-900 p-8 shadow-2xl">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-cyan-300">
          Local pull request review
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">
          Patchdesk
        </h1>
        <p className="mt-4 text-lg text-slate-300">
          Open a pull request to begin a local review.
        </p>
      </section>
    </main>
  );
}
