// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useMarkdownPreviewPaths } from "../../src/renderer/src/hooks/use-markdown-preview-paths";

const sourceChanges = [
  [
    "patch",
    {
      patch: "patch-b",
      sourceSession: { profileId: "profile-a", sessionId: "session-a" },
    },
  ],
  [
    "profile",
    {
      patch: "patch-a",
      sourceSession: { profileId: "profile-b", sessionId: "session-a" },
    },
  ],
  [
    "session",
    {
      patch: "patch-a",
      sourceSession: { profileId: "profile-a", sessionId: "session-b" },
    },
  ],
] as const;

describe("useMarkdownPreviewPaths", () => {
  it("tracks preview paths independently", () => {
    const { result } = renderHook(() =>
      useMarkdownPreviewPaths("patch-a", {
        profileId: "profile-a",
        sessionId: "session-a",
      }),
    );

    act(() => result.current.setPreview("README.md", true));
    act(() => result.current.setPreview("docs/guide.md", true));
    act(() => result.current.setPreview("README.md", false));

    expect([...result.current.paths]).toEqual(["docs/guide.md"]);
  });

  it.each(sourceChanges)(
    "clears paths when the %s changes",
    (_, nextSource) => {
      const { result, rerender } = renderHook(
        ({ patch, sourceSession }) =>
          useMarkdownPreviewPaths(patch, sourceSession),
        {
          initialProps: {
            patch: "patch-a",
            sourceSession: { profileId: "profile-a", sessionId: "session-a" },
          },
        },
      );

      act(() => result.current.setPreview("README.md", true));
      rerender(nextSource);

      expect(result.current.paths.size).toBe(0);
    },
  );
});
