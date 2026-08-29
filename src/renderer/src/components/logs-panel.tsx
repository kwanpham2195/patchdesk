import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";

import { requestJson } from "../api-client";
import type { RawJsonValue } from "../../../domain/json";
import {
  parseLogEntry,
  type LogEntry,
  type LogLevel,
  type LogProcess,
} from "../../../domain/log-entry";
import { useLatestCommitted } from "../hooks/use-latest-committed";
import { cn } from "../lib/utils";
import * as v from "valibot";
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
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";

const MAX_DISPLAYED = 1_000;
const POLL_INTERVAL_MS = 2_000;

const logsPayloadSchema = v.object({
  entries: v.optional(v.array(v.unknown())),
  nextAfter: v.optional(v.number()),
});

type LogsPayload = v.InferOutput<typeof logsPayloadSchema>;

type LogStreamState = {
  readonly requestId: number;
  readonly entries: ReadonlyArray<LogEntry>;
  readonly afterSeq?: number;
  readonly error?: string;
};

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

function parseLogsPayload(
  value: RawJsonValue | undefined,
): LogsPayload | undefined {
  const parsed = v.safeParse(logsPayloadSchema, value);
  return parsed.success ? parsed.output : undefined;
}

/** The semantic status token one log level is rendered in. */
// oxlint-disable-next-line react/only-export-components -- Shared presentation rule, tested as a function in tests/renderer/log-level-class.test.ts.
export function levelClass(level: LogLevel): string {
  switch (level) {
    case "error":
      return "text-destructive";
    case "warn":
      return "text-status-warning";
    case "info":
      return "text-status-info";
    case "debug":
      return "text-muted-foreground";
  }
}

/** Live tail of the unified main + renderer log stream. */
export function LogsPanel(): React.JSX.Element {
  const [stream, setStream] = useState<LogStreamState>({
    requestId: 0,
    entries: [],
  });
  const [paused, setPaused] = useState(false);
  const [levelFilter, setLevelFilter] = useState<"all" | LogLevel>("all");
  const [processFilter, setProcessFilter] = useState<"all" | LogProcess>("all");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const pausedRef = useLatestCommitted(paused);
  const afterSeqRef = useLatestCommitted(stream.afterSeq);
  const requestIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const load = (after: number | undefined): void => {
      const requestId = ++requestIdRef.current;
      setStream((current) => ({ ...current, requestId }));
      const query =
        after === undefined ? "limit=300" : `after=${after}&limit=500`;
      void requestJson(`/v1/logs?${query}`)
        .then((value) => {
          const payload = parseLogsPayload(value);
          if (cancelled || payload === undefined) return;
          const incoming = (payload.entries ?? [])
            .map(parseLogEntry)
            .filter((entry): entry is LogEntry => entry !== undefined);
          // The cursor is the last delivered sequence (or the supplied cursor
          // when nothing arrived); it is sent back unchanged on the next poll.
          setStream((current) => {
            if (current.requestId !== requestId) return current;
            const merged =
              after === undefined
                ? incoming
                : [...current.entries, ...incoming];
            const nextAfter = payload.nextAfter ?? after;
            if (nextAfter === undefined) {
              return {
                requestId,
                entries: merged.slice(-MAX_DISPLAYED),
              };
            }
            return {
              requestId,
              entries: merged.slice(-MAX_DISPLAYED),
              afterSeq: nextAfter,
            };
          });
        })
        .catch(() => {
          if (cancelled) return;
          setStream((current) =>
            current.requestId === requestId
              ? {
                  ...current,
                  error: "Could not load the log stream. Try again.",
                }
              : current,
          );
        });
    };
    load(undefined);
    const timer = setInterval(() => {
      if (!pausedRef.current) load(afterSeqRef.current);
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [afterSeqRef, pausedRef]);

  useEffect(() => {
    const container = scrollRef.current;
    if (container === null || !atBottomRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, [stream.entries]);

  const visible = stream.entries.filter(
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
              if (value !== null) {
                // SAFETY: The catalog contains only all or LogLevel values.
                setLevelFilter(value as "all" | LogLevel);
              }
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
              <SelectGroup>
                {levelOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select
            value={processFilter}
            items={processOptions}
            onValueChange={(value) => {
              if (value !== null) {
                // SAFETY: The catalog contains only all or LogProcess values.
                setProcessFilter(value as "all" | LogProcess);
              }
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
              <SelectGroup>
                {processOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        {stream.error === undefined ? null : (
          <Alert variant="destructive">
            <AlertTitle>Logs unavailable</AlertTitle>
            <AlertDescription>{stream.error}</AlertDescription>
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
              {stream.entries.length === 0
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
