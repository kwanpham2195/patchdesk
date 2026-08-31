import { useEffect, useRef, useState, type TransitionEvent } from "react";

type WalkthroughFocusTransition = "idle" | "leaving" | "entering";

/** Coordinates the two-phase Walkthrough focus layout transition. */
export function useWalkthroughFocusTransition() {
  const [walkthroughFocused, setWalkthroughFocused] = useState(false);
  const [walkthroughFocusTransition, setWalkthroughFocusTransition] =
    useState<WalkthroughFocusTransition>("idle");
  const requestedWalkthroughFocus = useRef(false);
  const pendingWalkthroughFocusFrame = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (pendingWalkthroughFocusFrame.current !== null)
        window.cancelAnimationFrame(pendingWalkthroughFocusFrame.current);
    },
    [],
  );

  const requestWalkthroughFocusChange = (next: boolean): void => {
    if (walkthroughFocusTransition !== "idle" || next === walkthroughFocused)
      return;
    requestedWalkthroughFocus.current = next;
    setWalkthroughFocusTransition("leaving");
  };

  const handleWalkthroughFocusTransitionEnd = (
    event: TransitionEvent<HTMLElement>,
  ): void => {
    if (
      event.target !== event.currentTarget ||
      event.propertyName !== "opacity" ||
      walkthroughFocusTransition !== "leaving"
    )
      return;
    setWalkthroughFocused(requestedWalkthroughFocus.current);
    setWalkthroughFocusTransition("entering");
    pendingWalkthroughFocusFrame.current = window.requestAnimationFrame(() => {
      pendingWalkthroughFocusFrame.current = window.requestAnimationFrame(
        () => {
          pendingWalkthroughFocusFrame.current = null;
          setWalkthroughFocusTransition("idle");
        },
      );
    });
  };

  return {
    walkthroughFocused,
    walkthroughFocusTransition,
    requestWalkthroughFocusChange,
    handleWalkthroughFocusTransitionEnd,
  };
}
