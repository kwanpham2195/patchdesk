import { createElement, useCallback, useState, type ReactNode } from "react";
import { MarkdownLightbox } from "./components/markdown-lightbox";

/** The lightbox element plus the two controls `useLightbox` hands its caller. */
type LightboxController = {
  readonly lightbox: () => React.JSX.Element;
  /** `actions` adds controls to the viewer's toolbar, such as opening the link an image stood for. */
  readonly open: (content: ReactNode, actions?: ReactNode) => void;
  readonly close: () => void;
};

/** Convenience hook: manages open/close state and the lightbox element. */
export function useLightbox(): LightboxController {
  const [isOpen, setIsOpen] = useState(false);
  const [content, setContent] = useState<ReactNode>(null);
  const [actions, setActions] = useState<ReactNode>(null);

  const close = useCallback(() => setIsOpen(false), []);
  const open = useCallback((c: ReactNode, a?: ReactNode) => {
    setContent(c);
    setActions(a ?? null);
    setIsOpen(true);
  }, []);

  const lightbox = useCallback(
    () =>
      createElement(
        MarkdownLightbox,
        { open: isOpen, onClose: close, actions },
        content,
      ),
    [isOpen, close, content, actions],
  );

  return { lightbox, open, close };
}
