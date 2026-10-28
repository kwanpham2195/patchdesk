import type { GuideSummary } from "#src/domain/guide-progress";
import type { NativeSessionAttemptPage } from "#src/domain/native-session-attempt";
import { requestJson } from "#src/renderer/src/api-client";
import { parseInsightRunResponse } from "#src/renderer/src/renderer-contracts";
import type { InsightRunDialogType } from "./insight-run-dialog";
import type { InsightProjection } from "./insight-panels";

/** Copies only the bounded metadata previously displayed in failed-run Details. */
export async function loadInsightFailureDiagnostics({
  projection,
  retainedHeadSha,
  guideFailure,
  nativeAttempts,
  source,
}: {
  readonly projection: InsightProjection;
  readonly retainedHeadSha: string | undefined;
  readonly guideFailure: NonNullable<GuideSummary["failure"]> | undefined;
  readonly nativeAttempts: NativeSessionAttemptPage | undefined;
  readonly source:
    | {
        readonly profileId: string;
        readonly reviewId: string;
        readonly type: InsightRunDialogType;
        readonly runId: string;
      }
    | undefined;
}): Promise<string> {
  let page = nativeAttempts;
  if (page === undefined && source !== undefined) {
    const query = new URLSearchParams({
      profileId: source.profileId,
      reviewId: source.reviewId,
      type: source.type,
    });
    const response = parseInsightRunResponse(
      await requestJson(
        `/v1/reviews/insights/runs/${encodeURIComponent(source.runId)}?${query}`,
      ),
    );
    if (response?.runId !== source.runId || response.type !== source.type)
      throw new Error("Unexpected Insight diagnostics response");
    page = response.nativeAttempts;
  }
  const failure = guideFailure ?? projection.replacementFailure;
  const fields: Array<readonly [string, string | number | undefined | null]> = [
    ["run", failure?.runId],
    ["failure", failure?.category],
    ["published_revision", retainedHeadSha ?? projection.retained?.headSha],
    ["requested_model", projection.replacementFailure?.model],
    ["requested_reasoning", projection.replacementFailure?.reasoning],
  ];
  for (const [index, attempt] of (page?.attempts ?? []).entries()) {
    const prefix = `attempt.${index + 1}.`;
    const metadata: typeof fields = [
      ["run", attempt.runId],
      ["generation", attempt.generation],
      ["attempt", attempt.attemptId],
      ["evidence", attempt.evidence],
      ["requested.provider", attempt.requested.provider],
      ["requested.model", attempt.requested.model],
      ["requested.reasoning", attempt.requested.reasoning],
      ["observed.provider", attempt.observed.nativeProvider],
      ["observed.model", attempt.observed.model],
      ["observed.reasoning", attempt.observed.reasoning],
      ["observed.version", attempt.observed.version],
      ["first_failure.phase", attempt.firstFailure?.phase],
      ["first_failure.code", attempt.firstFailure?.code],
      ["history.status", attempt.capture.status],
      [
        "history.bytes",
        attempt.capture.status === "retained"
          ? attempt.capture.bytes
          : undefined,
      ],
      ["history.completeness", attempt.capture.completeness],
      ["cleanup.abort", attempt.cleanup.abort],
      ["cleanup.host_work", attempt.cleanup.hostWork],
      ["cleanup.process", attempt.cleanup.process],
      ["cleanup.archive", attempt.cleanup.archive],
      ["cleanup.credential_home", attempt.cleanup.credentialHome],
      ["cleanup.scope", attempt.cleanup.scope],
      [
        "cleanup.detached_bash_descendants",
        attempt.cleanup.detachedBashDescendants,
      ],
    ];
    fields.push(
      ...metadata.map(([key, value]) => [prefix + key, value] as const),
    );
  }
  return fields
    .map(
      ([key, value]) =>
        `${key}=${String(value ?? "unavailable")
          .replace(/[\r\n]/gu, " ")
          .slice(0, 256)}`,
    )
    .join("\n");
}
