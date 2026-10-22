import { useEffect, useMemo, useSyncExternalStore, useRef } from "react";
import {
  WalkthroughReaderController,
  type WalkthroughReaderSnapshot,
  type WalkthroughSource,
} from "./walkthrough-reader-controller";

type PagedWalkthroughControls = {
  readonly reader: WalkthroughReaderController;
  readonly snapshot: WalkthroughReaderSnapshot;
};

/** Owns the controller's digest lifetime and restores the saved section directly. */
export function usePagedWalkthrough(
  source: WalkthroughSource,
  initialSectionId: string | null,
): PagedWalkthroughControls {
  const { profileId, reviewId, digest } = source;
  const initial = useRef(initialSectionId);
  const reader = useMemo(
    () => new WalkthroughReaderController({ profileId, reviewId, digest }),
    [profileId, reviewId, digest],
  );
  useEffect(() => {
    reader.selectSection(initial.current ?? "s1");
    return () => reader.dispose();
  }, [reader]);
  const snapshot = useSyncExternalStore(reader.subscribe, reader.getSnapshot);
  return { reader, snapshot };
}
