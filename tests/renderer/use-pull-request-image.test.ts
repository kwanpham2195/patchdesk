// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { parsePullRequestInput } from "../../src/domain/pull-request";
import {
  usePullRequestImage,
  type PullRequestImageSource,
} from "../../src/renderer/src/hooks/use-pull-request-image";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

const parsed = parsePullRequestInput(
  "https://github.com/centraldigital/patchdesk/pull/42",
);
if (parsed._tag === "err") throw new Error("Fixture pull request is invalid");
const source: PullRequestImageSource = {
  profileId: "centraldigital",
  pullRequest: parsed.value,
};

const dataUri = "data:image/png;base64,AAAA";

let desktop: DesktopDouble | undefined;
afterEach(() => {
  desktop?.restore();
  desktop = undefined;
});

/**
 * A fresh URL per test: the hook memoizes each resolved image for the life of
 * the module, so reusing one URL would answer a later test from the first
 * test's resolution instead of the route it installed.
 */
let nextImage = 0;
function imageUrl(): string {
  nextImage += 1;
  return `https://github.com/user-attachments/assets/image-${nextImage}`;
}

describe("usePullRequestImage", () => {
  it("asks the main process for the image and reports the data URI it answers with", async () => {
    const src = imageUrl();
    desktop = installDesktopDouble({
      "/v1/reviews/markdown-image": () => success({ dataUri }),
    });

    const { result } = renderHook(() =>
      usePullRequestImage({ source, src, visible: true }),
    );

    expect(result.current).toEqual({ _tag: "Pending" });
    await waitFor(() => {
      expect(result.current).toEqual({ _tag: "Ready", dataUri });
    });
    expect(desktop.request).toHaveBeenCalledWith({
      path: "/v1/reviews/markdown-image",
      method: "POST",
      body: {
        profileId: "centraldigital",
        host: "github.com",
        owner: "centraldigital",
        repo: "patchdesk",
        number: 42,
        url: src,
      },
    });
  });

  it("requests nothing until the image is visible", async () => {
    const src = imageUrl();
    desktop = installDesktopDouble({
      "/v1/reviews/markdown-image": () => success({ dataUri }),
    });

    const { result, rerender } = renderHook(
      (visible: boolean) => usePullRequestImage({ source, src, visible }),
      { initialProps: false },
    );

    expect(result.current).toEqual({ _tag: "Pending" });
    expect(desktop.request).not.toHaveBeenCalled();

    rerender(true);
    await waitFor(() => {
      expect(result.current).toEqual({ _tag: "Ready", dataUri });
    });
  });

  it("resolves the same image once however many copies are shown", async () => {
    const src = imageUrl();
    desktop = installDesktopDouble({
      "/v1/reviews/markdown-image": () => success({ dataUri }),
    });

    const first = renderHook(() =>
      usePullRequestImage({ source, src, visible: true }),
    );
    const second = renderHook(() =>
      usePullRequestImage({ source, src, visible: true }),
    );

    await waitFor(() => {
      expect(first.result.current).toEqual({ _tag: "Ready", dataUri });
      expect(second.result.current).toEqual({ _tag: "Ready", dataUri });
    });
    expect(desktop.request).toHaveBeenCalledTimes(1);
  });

  it("evicts the oldest resolution once 32 images are memoized", async () => {
    desktop = installDesktopDouble({
      "/v1/reviews/markdown-image": () => success({ dataUri }),
    });
    const first = imageUrl();
    const newest = [first, ...Array.from({ length: 32 }, imageUrl)];

    // The first resolution plus 32 later ones, so the cap of 32 pushes the
    // first out while the newest one stays memoized.
    const show = async (src: string): Promise<void> => {
      const { result } = renderHook(() =>
        usePullRequestImage({ source, src, visible: true }),
      );
      await waitFor(() => {
        expect(result.current).toEqual({ _tag: "Ready", dataUri });
      });
    };
    for (const src of newest) await show(src);

    const resolved = desktop.request.mock.calls.length;
    await show(newest.at(-1) ?? first);
    expect(desktop.request.mock.calls.length).toBe(resolved);
    await show(first);
    expect(desktop.request.mock.calls.length).toBe(resolved + 1);
  });

  it("fails without a source, since the main process needs a profile to fetch as", async () => {
    const src = imageUrl();
    const { result } = renderHook(() =>
      usePullRequestImage({ source: undefined, src, visible: true }),
    );

    await waitFor(() => {
      expect(result.current).toEqual({ _tag: "Failed" });
    });
  });

  it("fails when the main process refuses the image", async () => {
    const src = imageUrl();
    desktop = installDesktopDouble({
      "/v1/reviews/markdown-image": () =>
        failure({ error: "invalid_input" }, 400),
    });

    const { result } = renderHook(() =>
      usePullRequestImage({ source, src, visible: true }),
    );

    await waitFor(() => {
      expect(result.current).toEqual({ _tag: "Failed" });
    });
  });

  it("fails when the answer is not a data URI", async () => {
    const src = imageUrl();
    desktop = installDesktopDouble({
      "/v1/reviews/markdown-image": () =>
        success({ dataUri: "https://github.com/a.png" }),
    });

    const { result } = renderHook(() =>
      usePullRequestImage({ source, src, visible: true }),
    );

    await waitFor(() => {
      expect(result.current).toEqual({ _tag: "Failed" });
    });
  });
});
