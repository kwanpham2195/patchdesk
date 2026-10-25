import { useState } from "react";
import type { NativeSessionAttemptPage } from "#src/domain/native-session-attempt";
import { requestJson } from "#src/renderer/src/api-client";
import { parseInsightRunResponse } from "#src/renderer/src/renderer-contracts";
import type { InsightRunDialogType } from "./insight-run-dialog";
import { Button } from "./ui/button";

export function InsightAttemptDetails({
  page,
  source,
}: {
  readonly page: NativeSessionAttemptPage | undefined;
  readonly source?:
    | {
        readonly profileId: string;
        readonly reviewId: string;
        readonly type: InsightRunDialogType;
        readonly runId: string;
      }
    | undefined;
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<NativeSessionAttemptPage>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const current = loaded ?? page;
  const load = async (): Promise<void> => {
    if (source === undefined || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const query = new URLSearchParams({
        profileId: source.profileId,
        reviewId: source.reviewId,
        type: source.type,
      });
      if (current?.nextCursor != null)
        query.set("nativeAttemptCursor", current.nextCursor);
      const response = parseInsightRunResponse(
        await requestJson(
          `/v1/reviews/insights/runs/${encodeURIComponent(source.runId)}?${query}`,
        ),
      );
      if (
        response?.runId !== source.runId ||
        response.type !== source.type ||
        response.nativeAttempts === undefined
      ) {
        setFailed(true);
      } else setLoaded(response.nativeAttempts);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-2 break-words">
      {current === undefined || current.attempts.length === 0 ? (
        <p>
          {current === undefined && source !== undefined
            ? "Native attempt details have not been loaded."
            : "Native attempt details unavailable."}{" "}
          This does not establish whether the provider ran or spent allowance.
        </p>
      ) : (
        current.attempts.map((attempt) => (
          <div
            key={attempt.attemptId}
            className="flex flex-col gap-1 rounded-md border p-3"
          >
            <p>
              Run: {attempt.runId} · Generation: {attempt.generation} · Attempt:{" "}
              {attempt.attemptId}
            </p>
            <p>Captured evidence: {attempt.evidence}</p>
            <p>
              Requested: {attempt.requested.provider} ·{" "}
              {attempt.requested.model} · {attempt.requested.reasoning}
            </p>
            <p>
              Observed provider:{" "}
              {attempt.observed.nativeProvider ?? "unavailable"} · Model:{" "}
              {attempt.observed.model ?? "unavailable"} · Reasoning:{" "}
              {attempt.observed.reasoning ?? "unavailable"} · Version:{" "}
              {attempt.observed.version ?? "unavailable"}
            </p>
            <p>
              First host failure:{" "}
              {attempt.firstFailure === undefined
                ? "none recorded"
                : `${attempt.firstFailure.phase} · ${attempt.firstFailure.code}`}
            </p>
            <p>
              Native history:{" "}
              {attempt.capture.status === "retained"
                ? `${attempt.capture.bytes} captured bytes; completeness unknown`
                : `${attempt.capture.status}; completeness unknown`}
              . Retention does not prove a complete response.
            </p>
            <p>
              Abort: {attempt.cleanup.abort} · Host work:{" "}
              {attempt.cleanup.hostWork} · Process: {attempt.cleanup.process} ·
              Archive: {attempt.cleanup.archive} · Credential home:{" "}
              {attempt.cleanup.credentialHome}
            </p>
            <p>
              Cleanup scope: {attempt.cleanup.scope}. Detached Bash descendants:{" "}
              {attempt.cleanup.detachedBashDescendants}.
            </p>
          </div>
        ))
      )}
      {source === undefined ||
      (current !== undefined && current.nextCursor === null) ? null : (
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => void load()}
        >
          {busy
            ? "Loading details…"
            : current === undefined
              ? "Load attempt details"
              : "More attempts"}
        </Button>
      )}
      {current?.nextCursor == null || source !== undefined ? null : (
        <p>Older attempt details are available from the run record.</p>
      )}
      {failed ? (
        <p role="status">
          Attempt details could not be loaded. Host failure and recovery
          information above remain valid.
        </p>
      ) : null}
    </div>
  );
}
