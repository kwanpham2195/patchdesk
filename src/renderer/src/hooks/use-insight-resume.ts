import { useCallback, useState } from "react";

import type { GuideRunStatus } from "#src/domain/guide-progress";
import { requestJson } from "#src/renderer/src/api-client";

type Identity = { readonly profileId: string; readonly reviewId: string };
type InsightResumeControls = {
  readonly busy: boolean;
  readonly failed: boolean;
  readonly cancelling: boolean;
  readonly resume: () => void;
  readonly cancel: () => void;
};

/** Resume and Cancel a reopened paged Insight run through explicit, single requests. */
export function useInsightResume(
  type: "guide" | "walkthrough",
  identity: Identity,
  run: NonNullable<GuideRunStatus>,
  onSettled: () => void,
): InsightResumeControls {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const send = useCallback(
    (
      path: string,
      body: Record<string, string | number | boolean>,
      onAccepted?: () => void,
    ) => {
      setBusy(true);
      setFailed(false);
      void requestJson(path, { method: "POST", body: { ...identity, ...body } })
        .then(() => onAccepted?.())
        .catch(() => setFailed(true))
        .finally(() => {
          setBusy(false);
          onSettled();
        });
    },
    [identity, onSettled],
  );
  const resume = useCallback(() => {
    if (run.status !== "paused" || run.native === undefined) return;
    if (
      run.native.lastStartHash === null ||
      run.native.starts === 0 ||
      !run.native.cessationConfirmed
    )
      return;
    send(`/v1/reviews/insights/${type}/resume`, {
      runId: run.runId,
      expectedGeneration: run.generation,
      transport: "native",
      acknowledgedStarts: run.native.starts,
      lastStartHash: run.native.lastStartHash,
      acknowledgeUnknownSpend: true,
    });
  }, [run, send, type]);
  const cancel = useCallback(
    () =>
      send(
        `/v1/reviews/insights/${type}/cancel`,
        {
          type,
          runId: run.runId,
        },
        () => setCancelling(true),
      ),
    [run.runId, send, type],
  );
  return { busy, failed, cancelling, resume, cancel };
}
