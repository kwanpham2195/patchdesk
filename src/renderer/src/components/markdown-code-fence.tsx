import { useEffect, useRef, useState } from "react";
import { getSharedHighlighter } from "@pierre/diffs";

import { Button } from "@/components/ui/button";
import { diffColors } from "../diff-colors";
import { useDiffCodeTheme } from "../hooks/use-diff-code-theme";
import {
  classifyDiffFence,
  fencedCodeLanguage,
  type DiffFenceLineKind,
} from "../markdown-code-fence";
import { registerPierreThemeLoaders } from "../pierre-theme-loaders";

// The Diff tab registers these too, but a comment body can render before it
// mounts, and registration is idempotent.
registerPierreThemeLoaders();

// `whitespace-pre` rather than `pre-wrap`: a long line scrolls sideways
// instead of wrapping, which is what the Diff tab does and what a reader
// needs to keep columns lined up.
const fenceClassName =
  "max-w-full overflow-x-auto whitespace-pre rounded-md bg-muted/50 p-3 font-mono text-xs leading-5";

/** Renders one fenced code block with the same highlighter the Diff tab uses. */
export function MarkdownCodeFence({
  lang,
  code,
}: {
  readonly lang?: string;
  readonly code: string;
}): React.JSX.Element {
  const language = fencedCodeLanguage(lang);
  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-10">
        <CopyCodeButton code={code} />
      </div>
      {language === "diff" ? (
        <DiffFence code={code} />
      ) : (
        <HighlightedFence code={code} language={language} />
      )}
    </div>
  );
}

function HighlightedFence({
  code,
  language,
}: {
  readonly code: string;
  readonly language: string | undefined;
}): React.JSX.Element {
  const theme = useDiffCodeTheme();
  const [html, setHtml] = useState<string>();

  useEffect(() => {
    setHtml(undefined);
    if (language === undefined) return;
    let active = true;
    getSharedHighlighter({ themes: [theme], langs: [language] })
      .then((highlighter) =>
        highlighter.codeToHtml(code, { lang: language, theme }),
      )
      .then((result) => {
        if (active) setHtml(result);
      })
      // A fence language the highlighter does not know rejects here. The
      // plain block below is already on screen, so there is nothing to undo.
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [code, language, theme]);

  if (html === undefined)
    return (
      <pre className={fenceClassName}>
        <code>{code}</code>
      </pre>
    );
  return (
    <div
      className="max-w-full overflow-x-auto rounded-md text-xs leading-5 [&>pre]:p-3 [&>pre]:font-mono"
      // Shiki escapes the code it tokenizes, so this is our own highlighter's
      // markup around text it already made safe.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function DiffFence({ code }: { readonly code: string }): React.JSX.Element {
  return (
    <pre className={fenceClassName}>
      <code>
        {classifyDiffFence(code).map((line, index) => (
          <span
            key={`${index}-${line.kind}`}
            className="block min-w-fit"
            style={lineStyle(line.kind)}
          >
            {line.text === "" ? "\n" : `${line.text}\n`}
          </span>
        ))}
      </code>
    </pre>
  );
}

function lineStyle(kind: DiffFenceLineKind): React.CSSProperties {
  switch (kind) {
    case "added":
      return {
        backgroundColor: diffColors.additionBackground,
        color: diffColors.additionText,
      };
    case "removed":
      return {
        backgroundColor: diffColors.deletionBackground,
        color: diffColors.deletionText,
      };
    case "meta":
      return { opacity: 0.7 };
    case "context":
      return {};
  }
}

/**
 * Copies one fence's source. Same honest behaviour as Brief's "Copy as diff":
 * the label only flips once the write resolves, and a rejection leaves it
 * alone rather than claiming success.
 */
function CopyCodeButton({
  code,
}: {
  readonly code: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(
    () => () => {
      clearTimeout(copiedTimer.current);
    },
    [],
  );
  return (
    <Button
      size="xs"
      variant="outline"
      onClick={() => {
        navigator.clipboard
          .writeText(code)
          .then(() => {
            setCopied(true);
            clearTimeout(copiedTimer.current);
            copiedTimer.current = setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}
