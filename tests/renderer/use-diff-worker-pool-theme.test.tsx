// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ContextType, ReactNode } from "react";
import { WorkerPoolContext } from "@pierre/diffs/react";

import { useDiffWorkerPoolTheme } from "../../src/renderer/src/hooks/use-diff-worker-pool-theme";
import type { DiffThemePreferences } from "../../src/renderer/src/diff-theme-preferences";

type WorkerPool = NonNullable<ContextType<typeof WorkerPoolContext>>;

function renderWithFakePool(theme: DiffThemePreferences) {
  const setRenderOptions = vi.fn(() => Promise.resolve());
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- WorkerPoolManager is a class with private fields, so no structural stub can be assignable to it; this hook only ever calls setRenderOptions.
  const pool = { setRenderOptions } as unknown as WorkerPool;
  const rendered = renderHook(
    ({ theme: current }: { readonly theme: DiffThemePreferences }) =>
      useDiffWorkerPoolTheme(current),
    {
      initialProps: { theme },
      wrapper: ({ children }: { readonly children: ReactNode }) => (
        <WorkerPoolContext.Provider value={pool}>
          {children}
        </WorkerPoolContext.Provider>
      ),
    },
  );
  return { ...rendered, setRenderOptions };
}

describe("useDiffWorkerPoolTheme", () => {
  it("puts the pool on the mounted theme pair", () => {
    const { setRenderOptions } = renderWithFakePool({
      light: "pierre-light",
      dark: "pierre-dark",
    });

    expect(setRenderOptions).toHaveBeenCalledTimes(1);
    expect(setRenderOptions).toHaveBeenLastCalledWith({
      theme: { light: "pierre-light", dark: "pierre-dark" },
    });
  });

  it("re-themes the pool when the preference changes", () => {
    const { rerender, setRenderOptions } = renderWithFakePool({
      light: "pierre-light",
      dark: "pierre-dark",
    });

    rerender({
      theme: { light: "github-light-high-contrast", dark: "pierre-dark" },
    });

    expect(setRenderOptions).toHaveBeenCalledTimes(2);
    expect(setRenderOptions).toHaveBeenLastCalledWith({
      theme: { light: "github-light-high-contrast", dark: "pierre-dark" },
    });
  });

  it("leaves the pool alone when a rerender carries the same theme names", () => {
    const { rerender, setRenderOptions } = renderWithFakePool({
      light: "pierre-light",
      dark: "pierre-dark",
    });

    // A fresh object with the same names: `setRenderOptions` drops the pool's
    // cached ASTs and repaints every mounted renderer, so it has to key on the
    // names rather than on the identity of the preference object.
    rerender({ theme: { light: "pierre-light", dark: "pierre-dark" } });

    expect(setRenderOptions).toHaveBeenCalledTimes(1);
  });
});
