// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useInboxView } from "../../src/renderer/src/hooks/use-inbox-view";
import {
  loadInboxViewPreferences,
  saveInboxViewPreferences,
} from "../../src/renderer/src/inbox-view-preferences";

const profileId = "acme";

/** A `(max-width: 1279px)` query whose width the test moves across the breakpoint. */
function installViewport(initiallyNarrow: boolean) {
  let matches = initiallyNarrow;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    get matches() {
      return matches;
    },
    addEventListener: (_type: "change", listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_type: "change", listener: () => void) =>
      listeners.delete(listener),
  }));
  return {
    resize: (narrow: boolean) => {
      matches = narrow;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

function mount() {
  return renderHook(() =>
    useInboxView({
      profileId,
      rows: [],
      onOpenReview: () => undefined,
      onOpenReviewId: () => undefined,
    }),
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("useInboxView narrow overlay", () => {
  it("keeps the overlay closed when the viewport narrows with the inline panel open", () => {
    saveInboxViewPreferences(profileId, { inspectorOpen: true });
    const viewport = installViewport(false);
    const { result } = mount();

    viewport.resize(true);

    expect(result.current.narrow).toBe(true);
    expect(result.current.overlayOpen).toBe(false);
    expect(result.current.inspectorOpen).toBe(true);
  });

  it("closes a requested overlay when the viewport crosses the breakpoint, leaving the inline preference alone", () => {
    saveInboxViewPreferences(profileId, { inspectorOpen: true });
    const viewport = installViewport(true);
    const { result } = mount();

    act(() => result.current.toggleInspector());
    expect(result.current.overlayOpen).toBe(true);

    viewport.resize(false);
    viewport.resize(true);

    expect(result.current.overlayOpen).toBe(false);
    expect(result.current.inspectorOpen).toBe(true);
    expect(loadInboxViewPreferences(profileId).inspectorOpen).toBe(true);
  });
});
