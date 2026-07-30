import { useState } from "react";
import { AlertTriangle, ArrowLeft, Eye, RefreshCw, RotateCcw, ShieldAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "../renderer/src/components/ui/alert";
import { Button } from "../renderer/src/components/ui/button";
import { recoveryActionLabel, recoveryCopy, type RecoveryActionKey, type RecoveryNoticeKey, type RecoveryTone } from "../renderer/src/review-copy";

/**
 * Display-safe recovery chip for Design scenarios. Renders the friendly copy
 * from the shared `review-copy` map and exactly one button, never any path,
 * identifier, lifecycle, or storage word. Used by the workbench recovery
 * scenarios and the inbox recovery row.
 */
export function DesignRecoveryChip({
  noticeKey,
  tone,
  actionKey,
  primaryLabel,
  snapshotReadable,
  onBackToInbox,
  onViewSnapshot,
}: {
  readonly noticeKey: RecoveryNoticeKey;
  readonly tone: RecoveryTone;
  readonly actionKey?: RecoveryActionKey;
  readonly primaryLabel?: string;
  readonly snapshotReadable?: boolean;
  readonly onBackToInbox?: () => void;
  readonly onViewSnapshot?: () => void;
}): React.JSX.Element {
  const copy = recoveryCopy(noticeKey);
  const [pressed, setPressed] = useState(false);
  const [status, setStatus] = useState<string | undefined>();
  const resolvedAction = actionKey ?? copy.actionKey;
  const label = primaryLabel ?? (resolvedAction === undefined ? null : recoveryActionLabel(resolvedAction));
  const isWorkbenchTarget = primaryLabel !== undefined;
  const Icon = tone === "destructive" ? ShieldAlert : tone === "warning" ? AlertTriangle : RefreshCw;
  return (
    <Alert data-tone={copy.tone} data-testid={`recovery-chip-${noticeKey}`} className="gap-2">
      <Icon />
      <AlertTitle>{copy.notice}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-2">
        {copy.reassurance}
        {label === null ? null : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={copy.tone === "destructive" ? "destructive" : copy.tone === "positive" ? "default" : "outline"}
              onClick={() => {
                setPressed(true);
                setStatus(`${label} selected for this local snapshot.`);
              }}
              data-pressed={pressed}
              data-testid={isWorkbenchTarget ? "recovery-primary-action" : undefined}
            >
              <RotateCcw /> {label}
            </Button>
            {isWorkbenchTarget ? (
              <>
                {snapshotReadable === true ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onViewSnapshot?.();
                      setStatus("Snapshot opened in Files.");
                    }}
                    data-testid="view-snapshot"
                  >
                    <Eye /> View snapshot
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onBackToInbox?.();
                    setStatus("Returned to inbox.");
                  }}
                  data-testid="back-to-inbox"
                >
                  <ArrowLeft /> Back to inbox
                </Button>
              </>
            ) : null}
          </div>
        )}
        {status !== undefined ? <p role="status" className="basis-full text-xs text-muted-foreground">{status}</p> : null}
      </AlertDescription>
    </Alert>
  );
}
