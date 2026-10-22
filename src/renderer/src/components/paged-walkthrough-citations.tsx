import { useEffect, useRef, useState } from "react";
import type { WalkthroughPage } from "#src/domain/walkthrough-progress";
import { definedProps } from "#src/domain/defined-props";
import {
  readWalkthroughPage,
  type WalkthroughSource,
} from "#src/renderer/src/hooks/walkthrough-reader-controller";
import {
  NarrativeWalkthroughDiff,
  type NarrativeHunk,
} from "./narrative-walkthrough-diff";
import type { WalkthroughDiffAuthoring } from "./walkthrough-diff-authoring";
import type { ReadOnlyConversationAnnotation } from "#src/renderer/src/inline-conversation-mapping";
import { InlineError } from "./ui/inline-error";
import { Button } from "./ui/button";

type Citation = Extract<
  WalkthroughPage,
  { kind: "citations" }
>["items"][number];
type EvidenceProps = {
  readonly source: WalkthroughSource;
  readonly sectionId: string;
  readonly annotations?: ReadonlyArray<ReadOnlyConversationAnnotation>;
  readonly diffAuthoring?: WalkthroughDiffAuthoring;
};

async function capturedText(
  source: WalkthroughSource,
  sectionId: string,
  hunkId: string,
  field: "path" | "header" | "filePrefix" | "raw",
  signal: AbortSignal,
): Promise<string> {
  let cursor: string | null = null;
  let text = "";
  do {
    signal.throwIfAborted();
    const page: WalkthroughPage = await readWalkthroughPage(
      source,
      {
        kind: "hunk_text",
        sectionId,
        hunkId,
        field,
        cursor,
      },
      { signal },
    );
    if (signal.aborted) return "";
    if (page.kind !== "hunk_text")
      throw new Error("Invalid Walkthrough hunk text");
    text += page.text;
    cursor = page.next;
  } while (cursor !== null);
  return text;
}

function CapturedCitation({
  source,
  sectionId,
  citation,
  annotations,
  diffAuthoring,
}: EvidenceProps & { readonly citation: Citation }): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const reservedHeight = useRef(160);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<
    | { readonly status: "loading" }
    | { readonly status: "failed" }
    | { readonly status: "ready"; readonly hunk: NarrativeHunk }
  >({ status: "loading" });
  useEffect(() => {
    const node = root.current;
    if (node === null) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      if (!visible)
        reservedHeight.current = Math.max(
          160,
          node.getBoundingClientRect().height,
        );
      setVisible(visible);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const { profileId, reviewId, digest } = source;
  useEffect(() => {
    if (!visible) {
      setState({ status: "loading" });
      return;
    }
    const controller = new AbortController();
    const identity = { profileId, reviewId, digest };
    void (async () => {
      const text = { path: "", header: "", filePrefix: "", raw: "" };
      // One visible card holds at most one request so it cannot exhaust the UI read pool alone.
      for (const field of ["path", "header", "filePrefix", "raw"] as const)
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- serialize each card's fields to avoid exhausting the shared UI read pool
        text[field] = await capturedText(
          identity,
          sectionId,
          citation.hunkId,
          field,
          controller.signal,
        );
      return text;
    })()
      .then(({ path, header, filePrefix, raw }) => {
        if (!controller.signal.aborted)
          setState({
            status: "ready",
            hunk: {
              id: citation.hunkId,
              path,
              header,
              filePrefix,
              raw,
              oldStart: citation.oldStart,
              oldLines: citation.oldLines,
              newStart: citation.newStart,
              newLines: citation.newLines,
            },
          });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "failed" });
      });
    return () => controller.abort();
  }, [visible, profileId, reviewId, digest, sectionId, citation]);
  return (
    <div
      ref={root}
      style={visible ? undefined : { minHeight: reservedHeight.current }}
      className="min-h-40"
      data-walkthrough-citation={citation.hunkId}
    >
      {!visible || state.status === "loading" ? (
        <p role="status">
          Loading {citation.hunkId} · {citation.path.text}…
        </p>
      ) : state.status === "failed" ? (
        <InlineError>
          Captured hunk could not be read. Reopen the Review to retry.
        </InlineError>
      ) : (
        <NarrativeWalkthroughDiff
          blockId={`${digest}:${sectionId}:${citation.hunkId}`}
          hunk={state.hunk}
          {...definedProps({ annotations, diffAuthoring })}
        />
      )}
    </div>
  );
}

/** One citation window is mounted; only cards intersecting the reading viewport load and render a hunk. */
export function PagedWalkthroughCitations({
  page,
  onPage,
  ...props
}: EvidenceProps & {
  readonly page: Extract<WalkthroughPage, { kind: "citations" }> | null;
  readonly onPage: (cursor: string | null) => void;
}): React.JSX.Element {
  if (page === null) return <p role="status">Loading citations…</p>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={page.previous === null}
          onClick={() => onPage(page.previous)}
        >
          Previous citations
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={page.next === null}
          onClick={() => onPage(page.next)}
        >
          More citations
        </Button>
      </div>
      {page.items.map((citation) => (
        <CapturedCitation
          key={`${props.source.digest}:${props.sectionId}:${citation.hunkId}`}
          {...props}
          citation={citation}
        />
      ))}
    </div>
  );
}
