import { Skeleton } from "@/components/ui/skeleton";

const rowPlaceholders = [
  "row-1",
  "row-2",
  "row-3",
  "row-4",
  "row-5",
  "row-6",
  "row-7",
  "row-8",
] as const;

const detailPlaceholders = [
  "Author",
  "Branch",
  "Current head",
  "Checks",
  "Changes",
] as const;

export function MaintainerInboxSkeleton(): React.JSX.Element {
  return (
    <div
      className="min-h-[calc(100vh-3rem)] min-w-0 bg-background min-[1280px]:grid min-[1280px]:h-full min-[1280px]:min-h-0 min-[1280px]:grid-cols-[minmax(0,1fr)_21rem] min-[1280px]:overflow-hidden"
      role="status"
      aria-busy="true"
      aria-label="Loading maintainer inbox"
    >
      <div className="min-w-0">
        <header className="flex flex-wrap items-start justify-between gap-2 border-b px-3 py-2.5">
          <div className="min-w-0">
            <Skeleton className="h-4 w-14" />
            <h1 className="mt-0.5 text-[17px] leading-5 font-semibold tracking-tight">
              Maintainer inbox
            </h1>
            <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
              Pull requests for the selected repository, filtered and ordered by
              GitHub.
            </p>
          </div>
          <Skeleton className="h-8 w-28" />
        </header>
        <div
          className="flex min-h-10 items-center gap-2 border-b px-3 py-1.5"
          aria-hidden="true"
        >
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-28" />
        </div>
        <div
          aria-hidden="true"
          className="hidden grid-cols-[minmax(10rem,1fr)_8rem_6rem_8rem_1.75rem_2.75rem] items-center gap-3 border-b px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground min-[1280px]:grid"
        >
          <span>Pull request</span>
          <span>Labels</span>
          <span>Author</span>
          <span>Changes</span>
          <span>CI</span>
          <span className="text-right">Updated</span>
        </div>
        <div className="divide-y" aria-hidden="true">
          {rowPlaceholders.map((row) => (
            <div
              key={row}
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-2 min-[1280px]:grid-cols-[minmax(10rem,1fr)_8rem_6rem_8rem_1.75rem_2.75rem]"
            >
              <Skeleton className="h-4 w-[min(30rem,80%)]" />
              <Skeleton className="hidden h-3 w-16 min-[1280px]:block" />
              <Skeleton className="hidden h-3 w-16 min-[1280px]:block" />
              <Skeleton className="hidden h-3 w-16 min-[1280px]:block" />
              <Skeleton className="hidden size-3.5 rounded-full min-[1280px]:block" />
              <Skeleton className="h-3 w-6 justify-self-end" />
            </div>
          ))}
        </div>
      </div>
      <aside
        className="hidden min-w-0 overflow-hidden border-l min-[1280px]:block"
        aria-hidden="true"
      >
        <div className="space-y-3 p-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Review details
            </p>
            <Skeleton className="mt-1.5 h-4 w-full" />
            <Skeleton className="mt-1.5 h-3 w-40" />
          </div>
          <div className="space-y-1.5 text-[11px]">
            {detailPlaceholders.map((label) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-muted-foreground">{label}</span>
                <Skeleton className="h-3 w-24" />
              </div>
            ))}
          </div>
          <Skeleton className="h-8 w-full" />
        </div>
      </aside>
    </div>
  );
}
