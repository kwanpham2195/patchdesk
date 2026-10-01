import type { BriefSignals } from "../brief-contracts";
import {
  BRIEF_SIGNAL_GROUPS,
  BRIEF_SIGNAL_LABELS,
  briefSignalWarns,
} from "../../../domain/brief-signals";

type BriefSignalRow = BriefSignals[number];

/**
 * The Signals block: every predefined check, grouped, lit when it matched and
 * muted at zero, so the reviewer sees what was checked as well as what fired.
 */
export function SignalsBlock({
  signals,
}: {
  readonly signals: BriefSignals;
}): React.JSX.Element {
  const byKind = new Map(signals.map((signal) => [signal.kind, signal]));
  return (
    <section aria-label="Signals" className="flex min-w-0 flex-col gap-2">
      <h3 className="flex items-baseline gap-2 text-sm font-medium">
        Signals
        <span className="text-xs font-normal text-muted-foreground">
          what to check before reading
        </span>
      </h3>
      <div className="grid min-w-0 gap-x-6 gap-y-3 rounded-md border p-3 text-xs md:grid-cols-3">
        {BRIEF_SIGNAL_GROUPS.map((group) => (
          <div key={group.title} className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              {group.title}
            </span>
            <ul className="flex min-w-0 flex-col gap-0.5">
              {group.kinds.map((kind) => {
                const signal = byKind.get(kind);
                return signal === undefined ? null : (
                  <SignalRow key={kind} signal={signal} />
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function SignalRow({
  signal,
}: {
  readonly signal: BriefSignalRow;
}): React.JSX.Element {
  const lit = signal.count > 0;
  const warns = briefSignalWarns(signal.kind);
  const tone = !lit
    ? { row: "", dot: "invisible", label: "text-muted-foreground/60" }
    : warns
      ? {
          row: "rounded bg-diff-modified-fg/10",
          dot: "bg-diff-modified-fg",
          label: "font-medium",
        }
      : { row: "rounded bg-accent", dot: "bg-diff-added-fg", label: "" };
  return (
    <li className={`flex min-w-0 flex-col px-1.5 py-1 ${tone.row}`}>
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={`size-2 shrink-0 rounded-full ${tone.dot}`}
        />
        <span className={tone.label}>{BRIEF_SIGNAL_LABELS[signal.kind]}</span>
        <span
          className={`ml-auto shrink-0 font-mono tabular-nums ${lit ? "font-medium" : "text-muted-foreground/60"}`}
        >
          {lit ? signal.count : "–"}
        </span>
      </span>
      {lit && (signal.detail !== undefined || signal.paths.length > 0) ? (
        <span
          className="truncate pl-4 text-muted-foreground"
          title={signal.paths.join("\n")}
        >
          {[signal.detail, signal.paths.join(", ")]
            .filter((part) => part !== undefined && part !== "")
            .join(" · ")}
        </span>
      ) : null}
    </li>
  );
}
