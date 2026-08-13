import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";

import { requestJson } from "../api-client";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";

type LogLevel = "debug" | "info" | "warn" | "error";
type LogProcess = "main" | "renderer";

type LogEntry = {
  readonly seq: number;
  readonly at: string;
  readonly process: LogProcess;
  readonly level: LogLevel;
  readonly topic: string;
  readonly message: string;
  readonly meta?: Readonly<Record<string, unknown>>;
};

const MAX_DISPLAYED = 1_000;
const POLL_INTERVAL_MS = 2_000;

const levelOptions: ReadonlyArray<{
  readonly value: "all" | LogLevel;
  readonly label: string;
}> = [
  { value: "all", label: "All levels" },
  { value: "error", label: "Error" },
  { value: "warn", label: "Warn" },
  { value: "info", label: "Info" },
  { value: "debug", label: "Debug" },
];

const processOptions: ReadonlyArray<{
  readonly value: "all" | LogProcess;
  readonly label: string;
}> = [
  { value: "all", label: "All processes" },
  { value: "main", label: "Main" },
  { value: "renderer", label: "Renderer" },
];

function isLogEntry(value: unknown): value is LogEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.seq === "number" &&
    typeof record.at === "string" &&
    (record.process === "main" || record.process === "renderer") &&
    (record.level === "debug" ||
      record.level === "info" ||
      record.level === "warn" ||
      record.level === "error") &&
    typeof record.topic === "string" &&
    typeof record.message === "string"
  );
}

function levelClass(level: LogLevel): string {
  switch (level) {
    case "error":
      return "text-red-600 dark:text-red-400";
    case "warn":
      return "text-amber-600 dark:text-amber-400";
    case "info":
      return "text-sky-600 dark:text-sky-400";
    case "debug":
      return "text-muted-foreground";
  }
}

/** Live tail of the unified main + renderer log stream. */
export function LogsPanel(): React.JSX.Element {
  const [entries, setEntries] = useState<ReadonlyArray<LogEntry>>([]);
  const [afterSeq, setAfterSeq] = useState<number | undefined>(undefined);
  const [paused, setPaused] = useState(false);
  const [levelFilter, setLevelFilter] = useState<"all" | LogLevel>("all");
  const [processFilter, setProcessFilter] = useState<"all" | LogProcess>("all");
  const [error, setError] = useState<string>();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const afterSeqRef = useRef<number | undefined>(undefined);
  afterSeqRef.current = afterSeq;

  useEffect(() => {
    let cancelled = false;
    const load = async (after: number | undefined): Promise<void> => {
      try {
        const query =
          after === undefined ? "limit=300" : `after=${after}&limit=500`;
        const value = await requestJson(`/v1/logs?${query}`);
        if (cancelled || typeof value !== "object" || value === null) return;
        const record = value as {
          readonly entries?: unknown;
          readonly nextAfter?: unknown;
        };
        const incoming = Array.isArray(record.entries)
          ? record.entries.filter(isLogEntry)
          : [];
        // The cursor is the last delivered sequence (or the supplied cursor
        // when nothing arrived); it is sent back unchanged on the next poll.
        if (typeof record.nextAfter === "number") {
          setAfterSeq(record.nextAfter);
        } else if (after !== undefined) {
          setAfterSeq(after);
        }
        setEntries((current) => {
          const merged =
            after === undefined ? incoming : [...current, ...incoming];
          return merged.slice(-MAX_DISPLAYED);
        });
        setError(undefined);
      } catch {
        if (!cancelled) setError("Could not load the log stream. Try again.");
      }
    };
    void load(undefined);
    const timer = setInterval(() => {
      if (!pausedRef.current) void load(afterSeqRef.current);
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const container = scrollRef.current;
    if (container === null || !atBottomRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, [entries]);

  const visible = entries.filter(
    (entry) =>
      (levelFilter === "all" || entry.level === levelFilter) &&
      (processFilter === "all" || entry.process === processFilter),
  );

  return (
    <Card data-testid="logs-card">
      <CardHeader>
        <CardTitle>Logs</CardTitle>
        <CardDescription>
          Live tail of local activity across the main process and renderer.
          Credentials are masked; entries also append to the patchdesk.jsonl log
          file in the app data directory.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPaused((current) => !current)}
            aria-label={paused ? "Resume log tail" : "Pause log tail"}
          >
            {paused ? (
              <Play data-icon="inline-start" />
            ) : (
              <Pause data-icon="inline-start" />
            )}
            {paused ? "Resume" : "Pause"}
          </Button>
          <Select
            value={levelFilter}
            items={levelOptions}
            onValueChange={(value) => {
              if (value !== null) setLevelFilter(value as "all" | LogLevel);
            }}
          >
            <SelectTrigger
              id="log-level-filter"
              size="sm"
              aria-label="Filter by level"
              className="w-36"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {levelOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={processFilter}
            items={processOptions}
            onValueChange={(value) => {
              if (value !== null) setProcessFilter(value as "all" | LogProcess);
            }}
          >
            <SelectTrigger
              id="log-process-filter"
              size="sm"
              aria-label="Filter by process"
              className="w-36"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {processOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {error === undefined ? null : (
          <Alert variant="destructive">
            <AlertTitle>Logs unavailable</AlertTitle>
            <AlertDescription role="alert">{error}</AlertDescription>
          </Alert>
        )}
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const container = event.currentTarget;
            atBottomRef.current =
              container.scrollHeight -
                container.scrollTop -
                container.clientHeight <
              40;
          }}
          className="h-[55vh] overflow-y-auto rounded-md border p-2 font-mono text-xs"
          aria-label="Log stream"
          role="log"
        >
          {visible.length === 0 ? (
            <p className="p-2 text-muted-foreground" role="status">
              {entries.length === 0
                ? "No log entries yet."
                : "No entries match the filters."}
            </p>
          ) : (
            <ol className="flex flex-col gap-1">
              {visible.map((entry) => (
                <li key={entry.seq} className="flex gap-2 px-1 py-0.5">
                  <span className="shrink-0 text-muted-foreground">
                    {entry.at.slice(11, 23)}
                  </span>
                  <span
                    className={cn(
                      "w-12 shrink-0 font-medium",
                      levelClass(entry.level),
                    )}
                  >
                    {entry.level}
                  </span>
                  <span className="w-16 shrink-0 text-muted-foreground">
                    {entry.process}
                  </span>
                  <span className="w-28 shrink-0 truncate text-muted-foreground">
                    {entry.topic}
                  </span>
                  <span className="min-w-0 flex-1">{entry.message}</span>
                  {entry.meta === undefined ? null : (
                    <span className="min-w-0 shrink truncate text-muted-foreground">
                      {JSON.stringify(entry.meta).slice(0, 240)}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
