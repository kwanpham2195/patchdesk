import { useEffect, useRef, useState, type Dispatch } from "react";

import { requestJson } from "../api-client";
import { parseInboxInsightReadinessResponse } from "../renderer-contracts";
import type { InboxResponse } from "../renderer-contracts";
import type { WorkspaceAction } from "../workspace-state";
import { useLatestCommitted } from "./use-latest-committed";

/**
 * Keeps each Pull requests row's Insight state in step with the local Insight
 * records, with no GitHub listing fetch (ADR 0032). It reads them when the
 * screen is shown, which covers a run that settled while a Review was open,
 * and again whenever the main process reports a settled run while the screen
 * stays shown. Nothing here runs on a timer.
 */
export function useInboxInsightReadiness({
  shown,
  inbox,
  dispatchWorkspace,
}: {
  readonly shown: boolean;
  readonly inbox: InboxResponse | undefined;
  readonly dispatchWorkspace: Dispatch<WorkspaceAction>;
}): void {
  const [settledCount, setSettledCount] = useState(0);
  const latestInbox = useLatestCommitted(inbox);
  const hasInbox = inbox !== undefined;
  const generation = useRef(0);

  useEffect(() => {
    if (window.patchdesk?.onInsightSettled === undefined) return;
    return window.patchdesk.onInsightSettled(() =>
      setSettledCount((count) => count + 1),
    );
  }, []);

  useEffect(() => {
    const current = latestInbox.current;
    const repository = current?.inbox.repositories[0]?.repo;
    if (
      !shown ||
      !hasInbox ||
      current === undefined ||
      repository === undefined
    )
      return;
    const rows = current.inbox.rows.map((row) => ({
      number: row.identity.number,
      headSha: row.currentHeadSha,
    }));
    if (rows.length === 0) return;
    const owner = ++generation.current;
    void (async () => {
      try {
        const read = parseInboxInsightReadinessResponse(
          await requestJson("/v1/inbox/insight-readiness", {
            method: "POST",
            body: { ...repository, rows },
          }),
        );
        if (read === undefined || generation.current !== owner) return;
        dispatchWorkspace({
          _tag: "insightReadinessRead",
          rows: read.rows.flatMap(({ number, insights }) => {
            const headSha = rows.find((row) => row.number === number)?.headSha;
            return headSha === undefined ? [] : [{ number, headSha, insights }];
          }),
        });
      } catch {
        // The row keeps the state it had; the next show or settled run reads again.
      }
    })();
  }, [shown, hasInbox, settledCount, latestInbox, dispatchWorkspace]);
}
