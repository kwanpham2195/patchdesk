import { useLayoutEffect, useRef, useState } from "react";

const REVIEW_DIFF_REGION_NAME = "Review diff";

/** Every mounted region's "recompute my name" callback, so one region
 * mounting or unmounting can prompt every other mounted region to re-check
 * its own position instead of only ever checking its own once at mount. */
const reviewDiffRegionListeners = new Set<() => void>();

function notifyReviewDiffRegions(): void {
  for (const listener of reviewDiffRegionListeners) listener();
}

/**
 * Almost every page mounts exactly one `<section aria-label="Review diff">`,
 * so the plain name below is what nearly all callers and tests see. The
 * walkthrough is the one place two can mount at once: it takes over the
 * workbench visually but doesn't unmount it, so the workbench's own region
 * and the walkthrough's cited-hunk region both sit in the document at the
 * same time, and axe's landmark-unique rule correctly rejects same-role
 * regions that share a name. Threading a "there might be a sibling" flag
 * through the workbench, the walkthrough, and this component for that one
 * case isn't worth it: instead, every region tracks its live position in
 * the rendered document, and every region re-checks that position whenever
 * any region (including itself) mounts or unmounts -- not only at its own
 * mount, since the region that collides might not be the one that changed.
 * The first "Review diff" region in document order keeps the plain name;
 * any later one earns a name built from its selected path (falling back to
 * its rank if the path is unknown), so no two regions ever collide.
 */
export function useReviewDiffRegionName(selectedPath: string | undefined) {
  const ref = useRef<HTMLElement | null>(null);
  const [name, setName] = useState(REVIEW_DIFF_REGION_NAME);
  useLayoutEffect(() => {
    const recompute = (): void => {
      const element = ref.current;
      if (element === null) return;
      const regions = document.querySelectorAll<HTMLElement>(
        `section[aria-label^="${REVIEW_DIFF_REGION_NAME}"]`,
      );
      const rank = Array.from(regions).indexOf(element) + 1;
      setName(
        rank <= 1
          ? REVIEW_DIFF_REGION_NAME
          : selectedPath === undefined
            ? `${REVIEW_DIFF_REGION_NAME} ${rank}`
            : `${REVIEW_DIFF_REGION_NAME} ${rank}: ${selectedPath}`,
      );
    };
    reviewDiffRegionListeners.add(recompute);
    notifyReviewDiffRegions();
    return () => {
      reviewDiffRegionListeners.delete(recompute);
      notifyReviewDiffRegions();
    };
  }, [selectedPath]);
  return { ref, name };
}
