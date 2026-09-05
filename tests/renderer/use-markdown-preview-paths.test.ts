// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useMarkdownPreviewPaths } from "../../src/renderer/src/hooks/use-markdown-preview-paths";

describe("useMarkdownPreviewPaths", () => {
  it("owns independent paths and clears them when the represented source changes", () => {
    const { result, rerender } = renderHook(
      ({ patch, sessionId }) =>
        useMarkdownPreviewPaths(patch, {
          profileId: "profile",
          sessionId,
        }),
      { initialProps: { patch: "patch-a", sessionId: "session-a" } },
    );

    act(() => result.current.setPreview("README.md", true));
    act(() => result.current.setPreview("docs/guide.md", true));
    act(() => result.current.setPreview("README.md", false));
    expect([...result.current.paths]).toEqual(["docs/guide.md"]);

    rerender({ patch: "patch-b", sessionId: "session-b" });
    expect(result.current.paths.size).toBe(0);
  });
});
