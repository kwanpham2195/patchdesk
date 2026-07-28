import { useEffect, useState } from "react";
import { CircleAlert, RotateCcw } from "lucide-react";

import { requestJson } from "@/api-client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Item, ItemActions, ItemContent, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import type { ReviewRecoveryView } from "../../../domain/review-recovery";
import { recoveryActionLabel, recoveryCopy } from "../review-copy";
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
  recoveryView,
  onStart,
  onSettled,
}: {
  readonly profileId: string;
  readonly sessionId: string;
  readonly attemptId?: string;
  readonly runId?: string;
  readonly recoveryView?: ReviewRecoveryView;
  readonly onStart?: () => Promise<void>;
  readonly onSettled?: (profileId: string, sessionId: string) => Promise<void>;
}): React.JSX.Element {
  const [projection, setProjection] = useState<Projection>();
  const [starting, setStarting] = useState(false);
  const [settling, setSettling] = useState<"completed" | "failed" | undefined>(undefined);
  const [settleError, setSettleError] = useState(false);
  const [pollNonce, setPollNonce] = useState(0);

  const settle = async (status: "completed" | "failed"): Promise<void> => {
    if (onSettled === undefined) return;
    setSettling(status);
    try {
      await onSettled(profileId, sessionId);
      setSettling(undefined);
    } catch {
      setSettling(undefined);
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
            `/v1/runs/${encodeURIComponent(runId)}?sessionId=${encodeURIComponent(sessionId)}${attemptId === undefined ? "" : `&attemptId=${encodeURIComponent(attemptId)}`}`,
          );
          const parsed = parseSafeRunProjection(value);
          if (parsed._tag === "err") throw new Error("invalid projection");
          if (cancelled) return;
          setProjection(parsed.value);
          if (parsed.value.status === "completed" || parsed.value.status === "failed") {
            await settle(parsed.value.status);
            return;
          }
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
  }, [attemptId, onSettled, pollNonce, profileId, runId, sessionId]);

  const start = async (): Promise<void> => {
    if (onStart === undefined || starting) return;
    setStarting(true);
    try { await onStart(); } finally { setStarting(false); }
  };

  if (runId === undefined) {
    const copy = recoveryCopy(recoveryView?.noticeKey ?? "review_interrupted");
    const actionKey = recoveryView?.actionKey;
    return (
      <Alert className="mt-4">
        <RotateCcw />
        <AlertTitle>{copy.notice}</AlertTitle>
        <AlertDescription className="mt-2">
          {copy.reassurance}
          {actionKey === undefined || onStart === undefined ? null : (
            <Button size="sm" className="mt-3 block" disabled={starting} onClick={() => void start()}>
              {starting ? "Starting…" : recoveryActionLabel(actionKey)}
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
          <Button size="sm" className="mt-3 block" onClick={() => { setSettleError(false); void settle(projection?.status === "failed" ? "failed" : "completed"); }}>Retry</Button>
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
              <ItemTitle>{settling === "completed" ? "Finalizing review…" : "Recording the outcome…"}</ItemTitle>
              <p className="text-xs text-muted-foreground">{settling === "completed" ? "Saving results" : "Updating the workbench"}</p>
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
            <ItemTitle>{runStatusTitle(current.status)}</ItemTitle>
            <p className="text-xs text-muted-foreground">{stepLabel(current.step)} · {formatElapsed(current.elapsedMs)}</p>
          </ItemContent>
          <ItemActions>
            <Badge variant={current.status === "failed" || current.status === "disconnected" ? "destructive" : "secondary"}>
              {current.status === "queued" || current.status === "connecting" || current.status === "running" ? <Spinner /> : null}
              {runStatusBadge(current.status)}
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
      </CardContent>
    </Card>
  );
}

function runStatusTitle(status: Projection["status"]): string {
  switch (status) {
    case "completed": return "Review ready";
    case "failed": return "Review couldn't finish";
    case "disconnected": return "Reconnect to review";
    case "queued":
    case "connecting":
    case "running": return "Review in progress";
  }
}

function runStatusBadge(status: Projection["status"]): string {
  switch (status) {
    case "completed": return "Ready";
    case "failed": return "Needs retry";
    case "disconnected": return "Disconnected";
    case "queued":
    case "connecting":
    case "running": return "In progress";
  }
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
