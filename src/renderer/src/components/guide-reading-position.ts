import { useLayoutEffect, type RefObject } from "react";
import type { GuideReadingContent } from "#src/domain/guide-reading-state";
import type { GuideReadingControls } from "#src/renderer/src/hooks/use-guide-reading-state";
import { useLatestCommitted } from "#src/renderer/src/hooks/use-latest-committed";

/** Expansion renders before restoration; later diff layout and viewport resizes keep the same content anchor. */
export function useGuideReadingPosition(
  root: RefObject<HTMLDivElement | null>,
  reading: GuideReadingControls | undefined,
): void {
  const latest = useLatestCommitted(reading);
  const runId = reading?.progress.runId;
  useLayoutEffect(() => {
    const content = root.current;
    const viewport = content?.closest<HTMLElement>(
      "[data-review-insight-document='guide'],[data-guide-viewport]",
    );
    if (
      content === null ||
      content === undefined ||
      viewport === null ||
      viewport === undefined ||
      runId === undefined
    )
      return;
    let restoring = false;
    let frame: number | undefined;
    let layout = "";
    const currentLayout = (): string =>
      `${viewport.clientWidth}:${viewport.clientHeight}:${content.offsetHeight}`;
    const restore = (): void => {
      const anchor = latest.current?.progress.anchor;
      if (anchor === undefined) return;
      layout = currentLayout();
      const target =
        anchor.kind === "top"
          ? undefined
          : content.querySelector<HTMLElement>(
              anchor.kind === "group"
                ? `[data-guide-group='${anchor.groupId}']`
                : `[data-guide-file='${anchor.groupId}/${anchor.fileId}']`,
            );
      restoring = true;
      if (anchor.kind === "top") viewport.scrollTop = 0;
      else if (target !== null && target !== undefined)
        viewport.scrollTop +=
          target.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top +
          anchor.offset;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        restoring = false;
      });
    };
    const record = (): void => {
      if (restoring) return;
      // Browser scroll anchoring can fire before ResizeObserver after a layout change.
      if (currentLayout() !== layout) {
        restore();
        return;
      }
      const controls = latest.current;
      if (controls === undefined) return;
      const top = viewport.getBoundingClientRect().top;
      const nodes = [
        ...content.querySelectorAll<HTMLElement>(
          "[data-guide-group],[data-guide-file]",
        ),
      ];
      const target = nodes
        .filter((node) => node.getBoundingClientRect().top <= top + 1)
        .at(-1);
      let anchor: GuideReadingContent["anchor"] = { kind: "top" };
      if (viewport.scrollTop > 0 && target !== undefined) {
        const offset = top - target.getBoundingClientRect().top;
        const file = target.dataset.guideFile;
        const group = target.dataset.guideGroup;
        if (file !== undefined) {
          const [groupId, fileId] = file.split("/");
          if (groupId !== undefined && fileId !== undefined)
            anchor = { kind: "file", groupId, fileId, offset };
        } else if (group !== undefined)
          anchor = { kind: "group", groupId: group, offset };
      }
      const progress = controls.progress;
      controls.edit({
        reviewedGroupIds: progress.reviewedGroupIds,
        expandedAppearances: progress.expandedAppearances,
        anchor,
      });
    };
    restore();
    const observer = new ResizeObserver(restore);
    observer.observe(content);
    observer.observe(viewport);
    viewport.addEventListener("scroll", record, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", record);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [latest, root, runId]);
}
