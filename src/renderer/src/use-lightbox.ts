import { createElement, useCallback, useState, type ReactNode } from "react";
import { MarkdownLightbox } from "./components/markdown-lightbox";

/** Convenience hook: manages open/close state and the lightbox element. */
export function useLightbox(): {
  readonly lightbox: () => React.JSX.Element;
  readonly open: (content: ReactNode) => void;
  readonly close: () => void;
} {
  const [isOpen, setIsOpen] = useState(false);
  const [content, setContent] = useState<ReactNode>(null);

  const close = useCallback(() => setIsOpen(false), []);
  const open = useCallback((c: ReactNode) => {
    setContent(c);
    setIsOpen(true);
  }, []);

  const lightbox = useCallback(
    () =>
      createElement(MarkdownLightbox, {
        open: isOpen,
        onClose: close,
        children: content,
      }),
    [isOpen, close, content],
  );

  return { lightbox, open, close };
}
