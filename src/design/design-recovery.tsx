import { useState } from "react";
import { AlertTriangle, RefreshCw, RotateCcw, ShieldAlert } from "lucide-react";

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
}: {
  readonly noticeKey: RecoveryNoticeKey;
  readonly tone: RecoveryTone;
  readonly actionKey?: RecoveryActionKey;
}): React.JSX.Element {
  const copy = recoveryCopy(noticeKey);
  const [pressed, setPressed] = useState(false);
  const resolvedAction = actionKey ?? copy.actionKey;
  const label = resolvedAction === undefined ? null : recoveryActionLabel(resolvedAction);
  const Icon = tone === "destructive" ? ShieldAlert : tone === "warning" ? AlertTriangle : RefreshCw;
  return (
    <Alert data-tone={copy.tone} data-testid={`recovery-chip-${noticeKey}`} className="gap-2">
      <Icon />
      <AlertTitle>{copy.notice}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-2">
        {copy.reassurance}
        {label === null ? null : (
          <Button
            size="sm"
            variant={copy.tone === "destructive" ? "destructive" : copy.tone === "positive" ? "default" : "outline"}
            onClick={() => setPressed(true)}
            data-pressed={pressed}
          >
            <RotateCcw /> {label}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
