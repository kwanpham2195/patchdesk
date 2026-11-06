import { useEffect, useId, useState } from "react";

import { useLightbox } from "#src/renderer/src/use-lightbox";

type DiagramSvg = {
  readonly inline: string;
  readonly expanded: string;
};

export function MermaidDiagram({
  source,
}: {
  readonly source: string;
}): React.JSX.Element {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [svg, setSvg] = useState<DiagramSvg>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setSvg(undefined);
    setFailed(false);
    void import("pele")
      .then(async ({ parse, render }) => {
        await document.fonts.ready;
        if (!active) return;
        const options = {
          links: false,
          images: false,
          autoDirection: false,
          maxEdges: 500,
          fontFamily: getComputedStyle(document.body).fontFamily,
        };
        const diagram = parse(source, options);
        setSvg({
          inline: render(diagram, {
            ...options,
            idPrefix: `patchdesk-mermaid-${id}`,
          }).svg,
          expanded: render(diagram, {
            ...options,
            idPrefix: `patchdesk-mermaid-${id}-expanded`,
          }).svg,
        });
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
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
  readonly svg?: DiagramSvg;
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
                className="mermaid-diagram [&>svg]:h-auto [&>svg]:max-h-[85vh] [&>svg]:w-[85vw]"
                dangerouslySetInnerHTML={{ __html: svg.expanded }}
              />,
            )
          }
        >
          <div role="img" aria-label="Mermaid diagram">
            <div
              aria-hidden="true"
              className="mermaid-diagram min-w-[201px] w-full [&>svg]:mx-auto [&>svg]:block [&>svg]:h-auto [&>svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: svg.inline }}
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
