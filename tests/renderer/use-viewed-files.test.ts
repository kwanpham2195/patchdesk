// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import * as v from "valibot";
import { afterEach, describe, expect, it } from "vitest";

import type { LocalApiDesktopRequest } from "../../src/main/ipc-contract";
import type { ReviewWorkbenchPatch } from "../../src/renderer/src/flows/use-review-observation";
import { useViewedFiles } from "../../src/renderer/src/hooks/use-viewed-files";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

let desktop: DesktopDouble | undefined;
afterEach(() => {
  desktop?.restore();
  desktop = undefined;
});

const viewedFilesPath = "/v1/reviews/viewed-files";

const savedBody = v.object({ paths: v.array(v.string()) });
const sentBody = v.object({
  reviewId: v.string(),
  sessionId: v.string(),
  paths: v.array(v.string()),
});
const sentRequest = v.object({ body: savedBody });

/** Answers each save with the set it was sent, as the route does. */
function echo(input: LocalApiDesktopRequest) {
  return success({ paths: v.parse(savedBody, input.body).paths });
}

function sentPaths(): ReadonlyArray<ReadonlyArray<string>> {
  return (desktop?.request.mock.calls ?? []).map(
    ([input]) => v.parse(sentRequest, input).body.paths,
  );
}

function renderViewedFiles(
  patches: ReviewWorkbenchPatch[],
  props: {
    readonly sessionId: string;
    readonly savedPaths?: ReadonlyArray<string>;
  },
) {
  return renderHook(
    (current: {
      readonly sessionId: string;
      readonly savedPaths?: ReadonlyArray<string>;
    }) =>
      useViewedFiles({
        profileId: "profile",
        reviewId: "review-42",
        sessionId: current.sessionId,
        savedPaths: current.savedPaths,
        onWorkbenchPatch: (patch) => patches.push(patch),
      }),
    { initialProps: props },
  );
}

function sentBodies(): ReadonlyArray<v.InferOutput<typeof sentBody>> {
  return (desktop?.request.mock.calls ?? []).map(([input]) =>
    v.parse(sentBody, v.parse(v.object({ body: v.unknown() }), input).body),
  );
}

describe("useViewedFiles", () => {
  it("marks a file at once and saves the whole set for the session", async () => {
    desktop = installDesktopDouble({ [viewedFilesPath]: echo });
    const patches: ReviewWorkbenchPatch[] = [];
    const { result } = renderViewedFiles(patches, {
      sessionId: "session-1",
      savedPaths: ["src/a.ts"],
    });

    act(() => result.current.setPaths(new Set(["src/a.ts", "src/b.ts"])));

    expect([...result.current.paths]).toEqual(["src/a.ts", "src/b.ts"]);
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(desktop.request.mock.calls[0]?.[0]).toMatchObject({
      path: viewedFilesPath,
      method: "POST",
      body: {
        profileId: "profile",
        reviewId: "review-42",
        sessionId: "session-1",
        paths: ["src/a.ts", "src/b.ts"],
      },
    });
    expect(patches[0]).toEqual({ viewedPaths: ["src/a.ts", "src/b.ts"] });
    expect(result.current.saveFailed).toBe(false);
  });

  it("restores the stored marks and reports the failure when a save fails", async () => {
    desktop = installDesktopDouble({
      [viewedFilesPath]: () => failure({ error: "storage" }),
    });
    const patches: ReviewWorkbenchPatch[] = [];
    const { result } = renderViewedFiles(patches, {
      sessionId: "session-1",
      savedPaths: ["src/a.ts"],
    });

    act(() => result.current.setPaths(new Set(["src/a.ts", "src/b.ts"])));

    await waitFor(() => expect(result.current.saveFailed).toBe(true));
    expect([...result.current.paths]).toEqual(["src/a.ts"]);
    expect(patches).toEqual([]);
  });

  it("stores the last set of a burst and ignores the earlier answer", async () => {
    let releaseFirst: (() => void) | undefined;
    let calls = 0;
    desktop = installDesktopDouble({
      [viewedFilesPath]: (input) => {
        calls += 1;
        if (calls > 1) return echo(input);
        return new Promise((resolve) => {
          releaseFirst = () => resolve(echo(input));
        });
      },
    });
    const patches: ReviewWorkbenchPatch[] = [];
    const { result } = renderViewedFiles(patches, { sessionId: "session-1" });

    act(() => result.current.setPaths(new Set(["src/a.ts"])));
    act(() => result.current.setPaths(new Set(["src/a.ts", "src/b.ts"])));
    act(() =>
      result.current.setPaths(new Set(["src/a.ts", "src/b.ts", "src/c.ts"])),
    );
    await waitFor(() => expect(releaseFirst).toBeDefined());
    releaseFirst?.();

    await waitFor(() => expect(patches).toHaveLength(2));
    expect(sentPaths()).toEqual([
      ["src/a.ts"],
      ["src/a.ts", "src/b.ts", "src/c.ts"],
    ]);
    expect(patches.at(-1)).toEqual({
      viewedPaths: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });
    expect([...result.current.paths]).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
  });

  it("keeps a switched-away Review's late save from sending the next Review's marks", async () => {
    const held: Array<() => void> = [];
    desktop = installDesktopDouble({
      [viewedFilesPath]: (input) =>
        new Promise((resolve) => {
          held.push(() => resolve(echo(input)));
        }),
    });
    const { result, rerender } = renderHook(
      (current: { readonly reviewId: string; readonly sessionId: string }) =>
        useViewedFiles({
          profileId: "profile",
          reviewId: current.reviewId,
          sessionId: current.sessionId,
          savedPaths: [],
          onWorkbenchPatch: () => undefined,
        }),
      { initialProps: { reviewId: "review-a", sessionId: "session-a" } },
    );

    act(() => result.current.setPaths(new Set(["src/a.ts"])));
    rerender({ reviewId: "review-b", sessionId: "session-b" });
    act(() => result.current.setPaths(new Set(["src/b.ts"])));
    act(() => result.current.setPaths(new Set(["src/b.ts", "src/c.ts"])));
    await waitFor(() => expect(held).toHaveLength(2));
    // Review A's save answers while Review B's first save is still open.
    await act(async () => held[0]?.());
    await act(async () => held[1]?.());
    await waitFor(() => expect(held).toHaveLength(3));
    await act(async () => held[2]?.());

    expect(sentBodies()).toEqual([
      { reviewId: "review-a", sessionId: "session-a", paths: ["src/a.ts"] },
      { reviewId: "review-b", sessionId: "session-b", paths: ["src/b.ts"] },
      {
        reviewId: "review-b",
        sessionId: "session-b",
        paths: ["src/b.ts", "src/c.ts"],
      },
    ]);
  });

  it("starts a new session from its own stored marks", () => {
    const { result, rerender } = renderViewedFiles([], {
      sessionId: "session-1",
      savedPaths: ["src/a.ts"],
    });

    rerender({ sessionId: "session-2", savedPaths: [] });

    expect(result.current.paths.size).toBe(0);
  });
});
