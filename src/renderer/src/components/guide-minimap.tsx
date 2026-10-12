import {
  useEffect,
  useRef,
  useState,
  useId,
  type RefObject,
  type ComponentProps,
} from "react";
import { GuideMinimapRail } from "./guide-minimap-rail";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Badge } from "./ui/badge";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

// Adapted from T3 Code TimelineMinimap at 8d199b4f7b918079161d5f43e0146c099301be08.
// The rendered notice keeps the upstream license in minified shipped bundles.
const T3_MINIMAP_LICENSE = `MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** Group navigation uses the reader's viewport; its existing scroll listener owns saved anchors. */
export function GuideMinimap({
  root,
  groups,
}: {
  readonly root: RefObject<HTMLDivElement | null>;
  readonly groups: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly explanation: string;
    readonly reviewed?: boolean;
    readonly files?: ReadonlyArray<{
      readonly id: string;
      readonly path: string;
    }>;
  }>;
}): React.JSX.Element | null {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(320);
  const [compact, setCompact] = useState(false);
  const [previewOffset, setPreviewOffset] = useState(0);
  const [previewWidth, setPreviewWidth] = useState(320);
  const rail = useRef<HTMLButtonElement>(null);
  const filesTrigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const railScroller = useRef<HTMLDivElement>(null);
  const skipFocusPreview = useRef(false);
  const triggerId = useId();
  useEffect(() => {
    const content = root.current;
    const viewport = content?.closest<HTMLElement>(
      "[data-review-insight-document='guide'],[data-guide-viewport]",
    );
    if (
      content === null ||
      content === undefined ||
      viewport === null ||
      viewport === undefined
    )
      return;
    const update = (): void => {
      const bounds = viewport.getBoundingClientRect();
      setViewportHeight(bounds.height);
      const reader = content.closest<HTMLElement>("[data-guide-reader]");
      const width = reader?.getBoundingClientRect().width ?? bounds.width;
      setCompact(width < 768);
      setPreviewWidth(Math.min(320, width));
      let preceding = 0;
      for (const [index, group] of groups.entries()) {
        const node = content.querySelector<HTMLElement>(
          `[data-guide-minimap-group='${group.id}']`,
        );
        if (node === null) continue;
        const rect = node.getBoundingClientRect();
        if (rect.top < bounds.bottom && rect.bottom > bounds.top) {
          setCurrentIndex(index);
          return;
        }
        if (rect.top <= bounds.top) preceding = index;
      }
      setCurrentIndex(preceding);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(content);
    observer.observe(viewport);
    viewport.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", update);
    };
  }, [groups, root]);

  const select = (index: number, fileId?: string): void => {
    const group = groups[index];
    const content = root.current;
    const viewport = content?.closest<HTMLElement>(
      "[data-review-insight-document='guide'],[data-guide-viewport]",
    );
    if (
      group === undefined ||
      content === null ||
      content === undefined ||
      viewport === null ||
      viewport === undefined
    )
      return;
    const target = content.querySelector<HTMLElement>(
      fileId === undefined
        ? `[data-guide-minimap-group='${group.id}']`
        : `[data-guide-file='${group.id}/${fileId}']`,
    );
    if (target === null) return;
    setActiveIndex(null);
    viewport.scrollTop +=
      target.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  };
  const activeGroup = activeIndex === null ? undefined : groups[activeIndex];
  const railHeight = Math.max(160, (groups.length - 1) * 24);
  if (groups.length === 0) return null;
  const preview = (index: number, keyboard = false): void => {
    const scroller = railScroller.current;
    const position = (index / Math.max(1, groups.length - 1)) * railHeight;
    if (keyboard && scroller !== null) {
      if (position < scroller.scrollTop) scroller.scrollTop = position;
      else if (position > scroller.scrollTop + scroller.clientHeight - 8)
        scroller.scrollTop = position - scroller.clientHeight + 8;
    }
    setPreviewOffset(position);
    setActiveIndex(index);
  };
  return (
    <nav
      aria-label="Guide groups"
      data-current-group={groups[currentIndex]?.id}
      data-license={T3_MINIMAP_LICENSE}
      className="min-h-0 min-w-0"
    >
      <Popover
        open={activeIndex !== null}
        triggerId={`${triggerId}-${compact ? "files" : "rail"}`}
        onOpenChange={(open, details) => {
          if (open) {
            if (activeIndex === null) preview(currentIndex);
          } else {
            if (details.reason === "escape-key") {
              const trigger = compact ? filesTrigger.current : rail.current;
              skipFocusPreview.current =
                !compact && document.activeElement !== trigger;
              trigger?.focus({ preventScroll: true });
            }
            setActiveIndex(null);
          }
        }}
      >
        <div className="flex min-w-0 items-center gap-2 @min-[48rem]:hidden">
          <Select
            value={groups[currentIndex]?.id}
            items={groups.map((group, index) => ({
              value: group.id,
              label: `${index + 1}. ${group.title}`,
            }))}
            onValueChange={(id) => {
              const index = groups.findIndex((group) => group.id === id);
              if (index >= 0) {
                select(index);
              }
            }}
          >
            <SelectTrigger
              aria-label="Choose Guide group"
              className="min-w-0 flex-1"
            >
              <SelectValue className="min-w-0 truncate" />
            </SelectTrigger>
            <SelectContent style={{ width: previewWidth }}>
              <SelectGroup>
                {groups.map((group, index) => (
                  <SelectItem key={group.id} value={group.id}>
                    <span className="min-w-0 whitespace-normal break-words">
                      {index + 1}. {group.title}
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <PopoverTrigger
            id={`${triggerId}-files`}
            render={<Button ref={filesTrigger} size="xs" variant="outline" />}
          >
            Files
          </PopoverTrigger>
        </div>
        <GuideMinimapRail
          groups={groups}
          currentIndex={currentIndex}
          activeIndex={activeIndex}
          label={`Jump to Guide group: ${activeGroup?.title ?? groups[currentIndex]?.title ?? "Guide"}`}
          triggerId={`${triggerId}-rail`}
          height={viewportHeight}
          railHeight={railHeight}
          rail={rail}
          scroller={railScroller}
          onPreview={preview}
          onSelect={select}
          onFocus={() => {
            if (skipFocusPreview.current) {
              skipFocusPreview.current = false;
              return;
            }
            preview(currentIndex, true);
          }}
          onFocusActions={() => {
            const action =
              popup.current?.querySelector<HTMLButtonElement>("button");
            if (action === null || action === undefined) return false;
            action.focus();
            return true;
          }}
        />
        {activeGroup === undefined ? null : (
          <PopoverContent
            ref={popup}
            role="note"
            aria-label={`Guide preview ${activeGroup.title}`}
            side={compact ? "bottom" : "right"}
            align="start"
            alignOffset={compact ? 0 : previewOffset}
            sideOffset={4}
            collisionAvoidance={{
              side: "flip",
              align: "shift",
              fallbackAxisSide: "none",
            }}
            initialFocus={false}
            finalFocus={false}
            hideWhenAnchorHidden
            style={{ width: compact ? previewWidth : 320 }}
            className="block max-h-[min(22.5rem,var(--available-height))] max-w-[calc(100vw-1rem)] space-y-3 overflow-y-auto"
          >
            <GuidePreview
              group={activeGroup}
              index={activeIndex ?? 0}
              onSelect={(fileId) => select(activeIndex ?? 0, fileId)}
            />
          </PopoverContent>
        )}
      </Popover>
    </nav>
  );
}

function GuidePreview({
  group,
  index,
  onSelect,
}: {
  readonly group: ComponentProps<typeof GuideMinimap>["groups"][number];
  readonly index: number;
  readonly onSelect: (fileId: string) => void;
}): React.JSX.Element {
  return (
    <>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          Group {index + 1} · {group.files?.length ?? 0} files
        </span>
        {group.reviewed ? <Badge variant="success">Reviewed</Badge> : null}
      </div>
      <p className="line-clamp-2 break-words text-sm font-medium">
        {group.title}
      </p>
      <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm text-muted-foreground">
        {group.explanation}
      </p>
      <div className="flex flex-col gap-1">
        {group.files?.map((file) => (
          <Button
            key={file.id}
            variant="ghost"
            size="sm"
            className="h-auto justify-start whitespace-normal break-all text-left font-mono text-xs"
            onClick={() => onSelect(file.id)}
          >
            {file.path}
          </Button>
        ))}
      </div>
    </>
  );
}
