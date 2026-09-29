import { useState } from "react";

import { FINDING_RESTORED_REFRESH_NOTICE } from "../review-copy";

/**
 * Findings whose Restore was saved while the Review reload failed. Each shows
 * the refresh notice until the Review projects its actions again or another
 * action starts on it.
 */
export function useRestoreRefreshNotices() {
  const [findingIds, setFindingIds] = useState<ReadonlySet<string>>(new Set());
  return {
    mark: (findingId: string): void =>
      setFindingIds((current) => new Set(current).add(findingId)),
    clear: (findingId: string): void =>
      setFindingIds((current) => {
        if (!current.has(findingId)) return current;
        const next = new Set(current);
        next.delete(findingId);
        return next;
      }),
    /** `actionsProjected`: the Review already offers this Finding's actions, so no notice is needed. */
    noticeFor: (
      findingId: string,
      actionsProjected: boolean,
    ): string | undefined =>
      findingIds.has(findingId) && !actionsProjected
        ? FINDING_RESTORED_REFRESH_NOTICE
        : undefined,
  };
}
