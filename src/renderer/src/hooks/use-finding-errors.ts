import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AnalysisFindingStatus,
  AnalysisResult,
} from "../analysis-headline";

type FindingSettlementSnapshot = {
  readonly disposition: "open" | "added" | "dismissed";
  readonly status?: AnalysisFindingStatus;
};

function findingSettlementSnapshots(
  result: AnalysisResult,
  statuses: Readonly<Record<string, AnalysisFindingStatus>> | undefined,
): ReadonlyMap<string, FindingSettlementSnapshot> {
  return new Map(
    result.findings.map((finding) => {
      const disposition = finding.disposition ?? "open";
      const status = statuses?.[finding.id];
      return [
        finding.id,
        status === undefined ? { disposition } : { disposition, status },
      ];
    }),
  );
}

function findingSettled(
  previous: FindingSettlementSnapshot | undefined,
  current: FindingSettlementSnapshot,
): boolean {
  if (current.disposition !== "open")
    return previous?.disposition !== current.disposition;
  if (current.status === "pending_review" || current.status === "published")
    return previous?.status !== current.status;
  return previous?.status === "locked" && current.status === "actionable";
}

/** Owns transient Finding errors and removes them after authoritative settlement. */
export function useFindingErrors(
  result: AnalysisResult,
  statuses: Readonly<Record<string, AnalysisFindingStatus>> | undefined,
) {
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const previousSnapshots = useRef<
    ReadonlyMap<string, FindingSettlementSnapshot> | undefined
  >(undefined);
  // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- authoritative Finding settlement invalidates only the obsolete local error for that Finding.
  useEffect(() => {
    const currentSnapshots = findingSettlementSnapshots(result, statuses);
    const previous = previousSnapshots.current;
    previousSnapshots.current = currentSnapshots;
    if (previous === undefined) return;
    const settledIds = [...currentSnapshots].flatMap(([findingId, snapshot]) =>
      findingSettled(previous.get(findingId), snapshot) ? [findingId] : [],
    );
    if (settledIds.length === 0) return;
    setErrors((current) => {
      const next = new Map(current);
      for (const findingId of settledIds) next.delete(findingId);
      return next;
    });
  }, [result, statuses]);
  const clear = useCallback((findingId: string) => {
    setErrors((current) => {
      const next = new Map(current);
      next.delete(findingId);
      return next;
    });
  }, []);
  const record = useCallback((findingId: string, message: string) => {
    setErrors((current) => {
      const next = new Map(current);
      next.set(findingId, message);
      return next;
    });
  }, []);
  return { errors, clear, record };
}
