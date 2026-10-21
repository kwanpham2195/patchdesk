import type { RawJsonValue } from "#src/domain/json";
import { requestJson } from "#src/renderer/src/api-client";

type PendingGuideRequest = { readonly start: () => void };

// One Guide request can issue two physical reads in parallel; two requests fit the shared four-read UI quota.
const MAX_GUIDE_REQUESTS = 2;
const pending: PendingGuideRequest[] = [];
let active = 0;

function drain(): void {
  while (active < MAX_GUIDE_REQUESTS) {
    const next = pending.shift();
    if (next === undefined) return;
    active += 1;
    next.start();
  }
}

/** FIFO admission shared by all Guide readers and progress saves; cancellation removes queued reads, never releases an active IPC lease early. */
export function requestGuideJson(
  path:
    | "/v1/reviews/insights/guide/summary"
    | "/v1/reviews/insights/guide/page"
    | "/v1/reviews/insights/guide/progress",
  init: Parameters<typeof requestJson>[1],
  options: { readonly signal?: AbortSignal } = {},
): Promise<RawJsonValue | undefined> {
  const { signal } = options;
  if (signal?.aborted === true)
    return Promise.reject(
      new DOMException("Guide request cancelled", "AbortError"),
    );
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      const index = pending.indexOf(entry);
      if (index < 0) return;
      pending.splice(index, 1);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("Guide request cancelled", "AbortError"));
    };
    const entry: PendingGuideRequest = {
      start: () => {
        signal?.removeEventListener("abort", abort);
        void requestJson(path, init)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            drain();
          });
      },
    };
    pending.push(entry);
    signal?.addEventListener("abort", abort, { once: true });
    drain();
  });
}
