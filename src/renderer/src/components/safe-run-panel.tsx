import { useEffect, useState } from "react";
import { CircleAlert, RotateCcw } from "lucide-react";

import { requestJson } from "@/api-client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Item, ItemActions, ItemContent, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";

type Projection = {
  readonly status: "queued" | "connecting" | "running" | "completed" | "failed" | "disconnected";
  readonly elapsedMs: number;
  readonly step: "preparing" | "inspecting" | "validating" | "drafting" | "complete" | "failed";
  readonly message?: string;
  readonly metadata?: {
    readonly agent: string;
    readonly model: string;
    readonly reasoning: string;
    readonly mode: string;
    readonly access: string;
  };
  readonly activity?: ReadonlyArray<{
    readonly at: string;
    readonly elapsedMs: number;
    readonly step: Projection["step"];
    readonly label: string;
  }>;
};

export function SafeRunPanel({
  profileId,
  sessionId,
  attemptId,
  runId,
  onStart,
  onCompleted,
}: {
  readonly profileId: string;
  readonly sessionId: string;
  readonly attemptId: string;
  readonly runId?: string;
  readonly onStart?: () => Promise<void>;
  readonly onCompleted?: (profileId: string, sessionId: string) => Promise<void>;
}): React.JSX.Element {
  const [projection, setProjection] = useState<Projection>();
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (runId === undefined) return;
    let cancelled = false;
    const observe = async (): Promise<void> => {
      let delayMs = 300;
      while (!cancelled) {
        try {
          const value = await requestJson(
            `/v1/runs/${encodeURIComponent(runId)}?sessionId=${encodeURIComponent(sessionId)}&attemptId=${encodeURIComponent(attemptId)}`,
          );
          if (!isProjection(value)) throw new Error("invalid projection");
          if (cancelled) return;
          setProjection(value);
          if (value.status === "completed") {
            if (onCompleted !== undefined) await onCompleted(profileId, sessionId);
            return;
          }
          if (value.status === "failed") return;
          delayMs = 300;
        } catch {
          if (!cancelled) setProjection({ status: "disconnected", elapsedMs: 0, step: "inspecting", message: "Patchdesk lost its local run connection. The review was not restarted." });
          delayMs = Math.min(delayMs * 2, 5_000);
        }
        await wait(delayMs);
      }
    };
    void observe();
    return () => { cancelled = true; };
  }, [attemptId, onCompleted, profileId, runId, sessionId]);

  const start = async (): Promise<void> => {
    if (onStart === undefined || starting) return;
    setStarting(true);
    try { await onStart(); } finally { setStarting(false); }
  };

  if (runId === undefined) {
    return (
      <Alert className="mt-4">
        <RotateCcw />
        <AlertTitle>This review is not running</AlertTitle>
        <AlertDescription className="mt-2">
          Reopening a session never restarts its workflow automatically.
          {onStart === undefined ? null : <Button size="sm" className="mt-3 block" disabled={starting} onClick={() => void start()}>{starting ? "Starting…" : "Start review"}</Button>}
        </AlertDescription>
      </Alert>
    );
  }

  const current = projection ?? { status: "connecting" as const, elapsedMs: 0, step: "preparing" as const };
  return (
    <Card
      className="mt-5 gap-0 rounded-lg py-0 shadow-none"
      aria-live="polite"
      aria-busy={current.status === "queued" || current.status === "connecting" || current.status === "running"}
    >
      <CardContent className="p-0">
        <Item className="rounded-b-none border-0 p-4">
          <ItemContent>
            <ItemTitle>Run status: {current.status}</ItemTitle>
            <p className="text-xs text-muted-foreground">
              {stepLabel(current.step)} · {formatElapsed(current.elapsedMs)}
            </p>
          </ItemContent>
          <ItemActions>
            <Badge variant={current.status === "failed" || current.status === "disconnected" ? "destructive" : "secondary"}>
              {current.status === "queued" || current.status === "connecting" || current.status === "running" ? <Spinner /> : null}
              {current.status}
            </Badge>
          </ItemActions>
        </Item>
        {current.message === undefined ? null : (
          <Alert className="m-3 mt-0 rounded-md border-0 bg-muted py-3 shadow-none">
            <CircleAlert />
            <AlertDescription>{current.message}</AlertDescription>
          </Alert>
        )}
        {current.metadata === undefined ? null : (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t px-4 py-3 text-xs">
            <div><dt className="text-muted-foreground">Agent</dt><dd>{current.metadata.agent}</dd></div>
            <div><dt className="text-muted-foreground">Model</dt><dd className="truncate" title={current.metadata.model}>{current.metadata.model}</dd></div>
            <div><dt className="text-muted-foreground">Reasoning</dt><dd>{current.metadata.reasoning}</dd></div>
            <div><dt className="text-muted-foreground">Mode</dt><dd>{current.metadata.mode}</dd></div>
            <div className="col-span-2"><dt className="text-muted-foreground">Access</dt><dd>{current.metadata.access}</dd></div>
          </dl>
        )}
        {current.activity === undefined || current.activity.length === 0 ? null : (
          <details className="border-t px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium">
              Activity ({current.activity.length})
            </summary>
            <ol className="mt-3 space-y-2 text-sm" aria-label="Review activity">
              {current.activity.map((event, index) => (
                <li key={`${event.step}-${event.elapsedMs}-${index}`}>
                  <span className="font-medium">{event.label}</span>
                  <span className="ml-2 text-muted-foreground">
                    {formatElapsed(event.elapsedMs)}
                  </span>
                </li>
              ))}
            </ol>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

function isProjection(value: unknown): value is Projection {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  if (
    typeof item.status !== "string" ||
    typeof item.elapsedMs !== "number" ||
    typeof item.step !== "string"
  ) return false;
  if (item.activity === undefined) return true;
  return Array.isArray(item.activity) && item.activity.length <= 40 && item.activity.every(isActivityEvent);
}

function isActivityEvent(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return typeof event.at === "string" &&
    typeof event.elapsedMs === "number" &&
    typeof event.step === "string" &&
    typeof event.label === "string" &&
    event.label.length <= 160;
}

function stepLabel(step: Projection["step"]): string {
  return step === "complete" ? "Review ready" : step === "failed" ? "Review stopped" : `${step[0]?.toUpperCase() ?? ""}${step.slice(1)} changes`;
}

function formatElapsed(elapsedMs: number): string {
  return `${Math.max(0, Math.round(elapsedMs / 1_000))}s elapsed`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
