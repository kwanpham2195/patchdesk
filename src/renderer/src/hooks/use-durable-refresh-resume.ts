import { useEffect, type RefObject } from "react";

/** Starts or resumes the durable refresh owned by the mounted Review key. */
export function useDurableRefreshResume(
  operationKey: string,
  mountEpoch: RefObject<number>,
  resume: (operationKey: string, mountEpoch: number) => Promise<void>,
): void {
  useEffect(() => {
    void resume(operationKey, mountEpoch.current);
  }, [mountEpoch, operationKey, resume]);
}
