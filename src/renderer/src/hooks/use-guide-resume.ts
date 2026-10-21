import { useCallback, useState } from "react";

import type { GuideRunStatus } from "#src/domain/guide-progress";
import { requestJson } from "#src/renderer/src/api-client";

type Identity = { readonly profileId: string; readonly reviewId: string };

/** Resume and Cancel for the Guide run a reopened workbench found; both are explicit, single requests. */
export function useGuideResume(
  identity: Identity,
  run: NonNullable<GuideRunStatus>,
  onSettled: () => void,
) {
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
    send("/v1/reviews/insights/guide/resume", {
      runId: run.runId,
      expectedGeneration: run.generation,
      acknowledgedDispatches: run.dispatches,
      lastRequestHash: run.lastRequestHash,
      acknowledgeUnknownSpend: true,
    });
  }, [run, send]);
  const cancel = useCallback(
    () =>
      send("/v1/reviews/insights/guide/cancel", {
        type: "guide",
        runId: run.runId,
      }),
    [run.runId, send],
  );
  return { busy, failed, resume, cancel };
}
