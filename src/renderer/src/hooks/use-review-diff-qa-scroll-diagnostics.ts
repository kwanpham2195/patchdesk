import { useEffect } from "react";
import type { RefObject } from "react";
import type { CodeViewHandle } from "@pierre/diffs/react";

/**
 * Captures passive, QA-only scroll evidence without altering native wheel or
 * trackpad delivery. Production builds leave this hook dormant.
 */
export function useReviewDiffQaScrollDiagnostics(
  viewerElement: HTMLDivElement | null,
  viewer: RefObject<CodeViewHandle<undefined> | null>,
): void {
  useEffect(() => {
    if (
      viewerElement === null ||
      !("patchdesk" in window) ||
      !window.patchdesk.qaScrollDiagnosticsEnabled
    ) {
      return;
    }

    const capture = (event: WheelEvent): void => {
      const outer = document.querySelector<HTMLElement>(
        "[data-review-scroll-container]",
      );
      const target = event.target instanceof Element ? event.target : undefined;
      const path = event
        .composedPath()
        .filter((entry): entry is Element => entry instanceof Element)
        .slice(0, 8)
        .map(
          (entry) =>
            entry.tagName.toLowerCase() +
            (entry.id.length === 0 ? "" : `#${entry.id}`),
        );
      const qaWindow = window as Window & {
        __patchdeskScrollDiagnostic?: Record<string, unknown>;
      };
      qaWindow.__patchdeskScrollDiagnostic = {
        wheelTarget: target?.tagName.toLowerCase(),
        composedPath: path,
        viewer: {
          scrollTop: viewerElement.scrollTop,
          scrollHeight: viewerElement.scrollHeight,
          clientHeight: viewerElement.clientHeight,
          clientWidth: viewerElement.clientWidth,
        },
        outer:
          outer === null
            ? undefined
            : {
                scrollTop: outer.scrollTop,
                scrollHeight: outer.scrollHeight,
                clientHeight: outer.clientHeight,
              },
        codeViewScrollHeight: viewer.current?.getInstance()?.getScrollHeight(),
      };
    };

    viewerElement.addEventListener("wheel", capture, {
      capture: true,
      passive: true,
    });
    return () => viewerElement.removeEventListener("wheel", capture, true);
  }, [viewer, viewerElement]);
}
