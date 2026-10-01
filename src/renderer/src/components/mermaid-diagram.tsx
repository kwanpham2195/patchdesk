import { useEffect, useId, useState } from "react";
import type { Mermaid } from "mermaid";

import { useLightbox } from "../use-lightbox";

let mermaidPromise: Promise<Mermaid> | undefined;

export function MermaidDiagram({
  source,
}: {
  readonly source: string;
}): React.JSX.Element {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [svg, setSvg] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const renderContainer = document.createElement("div");
    renderContainer.style.position = "fixed";
    renderContainer.style.left = "-10000px";
    renderContainer.style.top = "0";
    renderContainer.style.width = "800px";
    renderContainer.style.height = "600px";
    renderContainer.style.overflow = "hidden";
    renderContainer.style.visibility = "hidden";
    document.body.append(renderContainer);
    setSvg(undefined);
    setFailed(false);
    void loadMermaid()
      .then((mermaid) =>
        mermaid.render(`patchdesk-mermaid-${id}`, source, renderContainer),
      )
      .then((result) => {
        if (active) setSvg(result.svg);
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        renderContainer.remove();
      });
    return () => {
      active = false;
      renderContainer.remove();
    };
  }, [id, source]);

  return (
    <ClickableMermaid
      {...(svg === undefined ? {} : { svg })}
      source={source}
      failed={failed}
    />
  );
}

function ClickableMermaid({
  svg,
  source,
  failed,
}: {
  readonly svg?: string;
  readonly source: string;
  readonly failed: boolean;
}): React.JSX.Element {
  const { lightbox, open } = useLightbox();

  if (svg === undefined) {
    return (
      <div className="space-y-2 overflow-x-auto rounded-md border bg-background p-3">
        <div role="img" aria-label="Mermaid diagram">
          <p className="text-xs text-muted-foreground">
            {failed
              ? "Mermaid could not render this diagram."
              : "Rendering Mermaid diagram…"}
          </p>
        </div>
        <details open>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Mermaid source
          </summary>
          <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-xs">
            <code>{source}</code>
          </pre>
        </details>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2 overflow-x-auto rounded-md border bg-background p-3">
        <button
          type="button"
          className="w-full cursor-zoom-in text-left"
          onClick={() =>
            open(
              <div
                aria-hidden="true"
                className="[&>svg]:h-auto [&>svg]:max-h-[85vh] [&>svg]:w-[85vw]"
                dangerouslySetInnerHTML={{ __html: svg }}
              />,
            )
          }
        >
          <div role="img" aria-label="Mermaid diagram">
            <div
              aria-hidden="true"
              className="min-w-[201px] w-full [&>svg]:block [&>svg]:h-auto [&>svg]:min-w-[201px] [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        </button>
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Mermaid source
          </summary>
          <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-xs">
            <code>{source}</code>
          </pre>
        </details>
      </div>
      {lightbox()}
    </>
  );
}

function loadMermaid(): Promise<Mermaid> {
  if (mermaidPromise !== undefined) return mermaidPromise;
  mermaidPromise = import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "dark",
    });
    return mermaid;
  });
  return mermaidPromise;
}
