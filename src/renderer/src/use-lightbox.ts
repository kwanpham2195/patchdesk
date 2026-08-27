import { createElement, useCallback, useState, type ReactNode } from "react";
import { MarkdownLightbox } from "./components/markdown-lightbox";

/** The lightbox element plus the two controls `useLightbox` hands its caller. */
type LightboxController = {
  readonly lightbox: () => React.JSX.Element;
  readonly open: (content: ReactNode) => void;
  readonly close: () => void;
};

/** Convenience hook: manages open/close state and the lightbox element. */
export function useLightbox(): LightboxController {
  const [isOpen, setIsOpen] = useState(false);
  const [content, setContent] = useState<ReactNode>(null);

  const close = useCallback(() => setIsOpen(false), []);
  const open = useCallback((c: ReactNode) => {
    setContent(c);
    setIsOpen(true);
  }, []);

  const lightbox = useCallback(
    () =>
      createElement(
        MarkdownLightbox,
        { open: isOpen, onClose: close },
        content,
      ),
    [isOpen, close, content],
  );

  return { lightbox, open, close };
}
