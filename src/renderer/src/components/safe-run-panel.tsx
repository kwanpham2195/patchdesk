import { useEffect, useState } from "react";
import { ChevronDown, CircleAlert, RotateCcw } from "lucide-react";

import { requestJson } from "@/api-client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Item, ItemActions, ItemContent, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import {
  parseSafeRunProjection,
  type SafeRunProjection,
} from "../../../domain/safe-run-projection";

type Projection = SafeRunProjection;

export function SafeRunPanel({
  profileId,
  sessionId,
  attemptId,
  runId,
  recoveryMessage,
  recoveryActionLabel,
  startError,
  onStart,
  onCompleted,
}: {
  readonly profileId: string;
  readonly sessionId: string;
  readonly attemptId: string;
  readonly runId?: string;
  readonly recoveryMessage?: string;
  readonly recoveryActionLabel?: string;
  readonly startError?: string;
  readonly onStart?: () => Promise<void>;
  readonly onCompleted?: (profileId: string, sessionId: string) => Promise<void>;
}): React.JSX.Element {
  const [projection, setProjection] = useState<Projection>();
  const [starting, setStarting] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [settling, setSettling] = useState(false);
  const [settleError, setSettleError] = useState(false);
  const [pollNonce, setPollNonce] = useState(0);

  const settle = async (): Promise<void> => {
    if (onCompleted === undefined) return;
    setSettling(true);
    try {
      await onCompleted(profileId, sessionId);
      setSettling(false);
    } catch {
      setSettling(false);
      setSettleError(true);
    }
  };

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
          const parsed = parseSafeRunProjection(value);
          if (parsed._tag === "err") throw new Error("invalid projection");
          if (cancelled) return;
          setProjection(parsed.value);
          if (parsed.value.status === "completed") {
            await settle();
            return;
          }
          if (parsed.value.status === "failed") return;
          delayMs = 300;
        } catch {
          if (!cancelled) setProjection({ status: "disconnected", elapsedMs: 0, step: "inspecting", message: "Lost the local run connection — retrying automatically." });
          delayMs = Math.min(delayMs * 2, 5_000);
        }
        await wait(delayMs);
      }
    };
    void observe();
    return () => { cancelled = true; };
  }, [attemptId, onCompleted, pollNonce, profileId, runId, sessionId]);

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
          {recoveryMessage ?? "The previous review run did not finish."}
          {startError === undefined ? null : <span className="mt-1 block">{startError}</span>}
          {onStart === undefined ? null : (
            <Button size="sm" className="mt-3 block" disabled={starting} onClick={() => void start()}>
              {starting ? "Starting…" : (recoveryActionLabel ?? "Start review")}
            </Button>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  if (settleError) {
    return (
      <Alert className="mt-4" variant="destructive">
        <CircleAlert />
        <AlertTitle>Could not load the review outcome</AlertTitle>
        <AlertDescription className="mt-2">
          The run finished, but the workbench could not be updated.
          <Button size="sm" className="mt-3 block" onClick={() => { setSettleError(false); void settle(); }}>Retry</Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (settling) {
    return (
      <Card className="mt-5 gap-0 rounded-lg py-0 shadow-none" aria-live="polite" aria-busy="true">
        <CardContent className="p-0">
          <Item className="rounded-b-none border-0 p-4">
            <ItemContent>
              <ItemTitle>Finalizing review…</ItemTitle>
              <p className="text-xs text-muted-foreground">Saving results</p>
            </ItemContent>
            <ItemActions><Badge variant="secondary"><Spinner />saving</Badge></ItemActions>
          </Item>
        </CardContent>
      </Card>
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
            <AlertDescription className="mt-1 flex flex-wrap items-center gap-2">
              {current.message}
              {current.status === "disconnected" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setProjection(undefined);
                    setPollNonce((nonce) => nonce + 1);
                  }}
                >
                  Check again now
                </Button>
              ) : null}
            </AlertDescription>
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
          <Collapsible open={activityOpen} onOpenChange={setActivityOpen}>
            <div className="border-t px-4 py-3">
              <CollapsibleTrigger
                render={(
                  <Button variant="ghost" size="sm" className="w-full justify-between" />
                )}
              >
                Activity ({current.activity.length})
                <ChevronDown data-icon="inline-end" aria-hidden="true" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ol className="mt-3 flex flex-col gap-2 text-sm" aria-label="Review activity">
                  {current.activity.map((event, index) => (
                    <li key={`${event.step}-${event.elapsedMs}-${index}`} className="flex items-baseline gap-2">
                      <span className="font-medium">{event.label}</span>
                      <span className="text-muted-foreground">
                        {formatElapsed(event.elapsedMs)}
                      </span>
                    </li>
                  ))}
                </ol>
              </CollapsibleContent>
            </div>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
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
