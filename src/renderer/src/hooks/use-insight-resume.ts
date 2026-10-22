import { useCallback, useState } from "react";

import type { GuideRunStatus } from "#src/domain/guide-progress";
import { requestJson } from "#src/renderer/src/api-client";

type Identity = { readonly profileId: string; readonly reviewId: string };
type InsightResumeControls = {
  readonly busy: boolean;
  readonly failed: boolean;
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
  const send = useCallback(
    (path: string, body: Record<string, string | number | boolean>) => {
      setBusy(true);
      setFailed(false);
      void requestJson(path, { method: "POST", body: { ...identity, ...body } })
        .catch(() => setFailed(true))
        .finally(() => {
          setBusy(false);
          onSettled();
        });
    },
    [identity, onSettled],
  );
  const resume = useCallback(() => {
    if (run.lastRequestHash === null) return;
    send(`/v1/reviews/insights/${type}/resume`, {
      runId: run.runId,
      expectedGeneration: run.generation,
      acknowledgedDispatches: run.dispatches,
      lastRequestHash: run.lastRequestHash,
      acknowledgeUnknownSpend: true,
    });
  }, [run, send, type]);
  const cancel = useCallback(
    () =>
      send(`/v1/reviews/insights/${type}/cancel`, {
        type,
        runId: run.runId,
      }),
    [run.runId, send, type],
  );
  return { busy, failed, resume, cancel };
}
