import type { GuidePreparationFailureReason } from "#src/domain/guide-preparation";
import type { InsightFailureRecord } from "#src/domain/insight-run-binding-contract";

/** Maps a preparation failure to the FailureRecord code that settles its run. */
export function guideSettleCode(
  reason: GuidePreparationFailureReason,
): InsightFailureRecord["code"] {
  switch (reason) {
    case "aborted":
      return "cancelled";
    case "stale_source":
      return "evidence_changed";
    case "too_large":
      return "resource_exhausted";
    case "invalid_source":
    case "not_indexable":
    case "sensitive_value":
    case "context_unavailable":
      return "evidence_missing";
    default:
      return "storage_unavailable";
  }
}

/** How a refused Guide admission reads in the coordinator's failure vocabulary. */
export function guideStartFailure(
  reason: GuidePreparationFailureReason,
): "already_running" | "stale_request" | "not_found" | "storage_unavailable" {
  switch (reason) {
    case "busy":
      return "already_running";
    case "stale_source":
      return "stale_request";
    case "invalid_source":
      return "not_found";
    default:
      return "storage_unavailable";
  }
}
