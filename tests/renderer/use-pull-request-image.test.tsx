// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { parsePullRequestInput } from "../../src/domain/pull-request";
import {
  PullRequestImageCacheProvider,
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
const src = "https://github.com/user-attachments/assets/diagram.png";

let desktop: DesktopDouble | undefined;
afterEach(() => {
  desktop?.restore();
  desktop = undefined;
});

/**
 * Every `renderHook` mounts its own provider, so one fixed URL is enough: no
 * test is answered from the resolution another test's route produced.
 */
const wrapper = ({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element => (
  <PullRequestImageCacheProvider>{children}</PullRequestImageCacheProvider>
);

/**
 * Counts image requests rather than every bridge call, because the renderer's
 * 300 ms log flush goes through the same double and lands by timing.
 */
function imageRequests(double: DesktopDouble): number {
  return double.request.mock.calls.filter(
    ([input]) => "path" in input && input.path === "/v1/reviews/markdown-image",
  ).length;
}

describe("usePullRequestImage", () => {
  it("asks the main process for the image and reports the data URI it answers with", async () => {
    desktop = installDesktopDouble({
      "/v1/reviews/markdown-image": () => success({ dataUri }),
    });

    const { result } = renderHook(
      () => usePullRequestImage({ source, src, visible: true }),
      { wrapper },
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
    desktop = installDesktopDouble({
      "/v1/reviews/markdown-image": () => success({ dataUri }),
    });

    const { result, rerender } = renderHook(
      (visible: boolean) => usePullRequestImage({ source, src, visible }),
      { initialProps: false, wrapper },
    );

    expect(result.current).toEqual({ _tag: "Pending" });
    expect(desktop.request).not.toHaveBeenCalled();

    rerender(true);
    await waitFor(() => {
      expect(result.current).toEqual({ _tag: "Ready", dataUri });
    });
  });

  it("resolves the same image once however many copies are shown", async () => {
    desktop = installDesktopDouble({
      "/v1/reviews/markdown-image": () => success({ dataUri }),
    });

    // Both copies in one tree, because a second `renderHook` would mount a
    // second provider and so a second cache.
    const { result } = renderHook(
      () => ({
        first: usePullRequestImage({ source, src, visible: true }),
        second: usePullRequestImage({ source, src, visible: true }),
      }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.first).toEqual({ _tag: "Ready", dataUri });
      expect(result.current.second).toEqual({ _tag: "Ready", dataUri });
    });
    expect(imageRequests(desktop)).toBe(1);
  });

  it("does not share resolutions across providers", async () => {
    desktop = installDesktopDouble({
      "/v1/reviews/markdown-image": () => success({ dataUri }),
    });

    const first = renderHook(
      () => usePullRequestImage({ source, src, visible: true }),
      { wrapper },
    );
    const second = renderHook(
      () => usePullRequestImage({ source, src, visible: true }),
      { wrapper },
    );

    await waitFor(() => {
      expect(first.result.current).toEqual({ _tag: "Ready", dataUri });
      expect(second.result.current).toEqual({ _tag: "Ready", dataUri });
    });
    expect(imageRequests(desktop)).toBe(2);
  });

  it("evicts the oldest resolution once 32 images are memoized", async () => {
    desktop = installDesktopDouble({
      "/v1/reviews/markdown-image": () => success({ dataUri }),
    });
    const imageSrc = (index: number): string =>
      `https://github.com/user-attachments/assets/image-${index}`;

    // One hook swapped between sources, because a `renderHook` per source
    // would mount a provider per source and never fill one cache.
    const { result, rerender } = renderHook(
      (shown: string) =>
        usePullRequestImage({ source, src: shown, visible: true }),
      { initialProps: imageSrc(0), wrapper },
    );
    const show = async (shown: string): Promise<void> => {
      rerender(shown);
      await waitFor(() => {
        expect(result.current).toEqual({ _tag: "Ready", dataUri });
      });
    };

    // The first resolution plus 32 later ones, so the cap of 32 pushes the
    // first out while the newest one stays memoized.
    for (let index = 0; index <= 32; index += 1) await show(imageSrc(index));

    expect(imageRequests(desktop)).toBe(33);
    // The second-oldest survived the one eviction the 33rd resolution forced,
    // and the oldest did not.
    await show(imageSrc(1));
    expect(imageRequests(desktop)).toBe(33);
    await show(imageSrc(0));
    expect(imageRequests(desktop)).toBe(34);
  });

  it("fails without a source, since the main process needs a profile to fetch as", async () => {
    const { result } = renderHook(
      () => usePullRequestImage({ source: undefined, src, visible: true }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current).toEqual({ _tag: "Failed" });
    });
  });

  it("fails when the main process refuses the image", async () => {
    desktop = installDesktopDouble({
      "/v1/reviews/markdown-image": () =>
        failure({ error: "invalid_input" }, 400),
    });

    const { result } = renderHook(
      () => usePullRequestImage({ source, src, visible: true }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current).toEqual({ _tag: "Failed" });
    });
  });

  it("fails when the answer is not a data URI", async () => {
    desktop = installDesktopDouble({
      "/v1/reviews/markdown-image": () =>
        success({ dataUri: "https://github.com/a.png" }),
    });

    const { result } = renderHook(
      () => usePullRequestImage({ source, src, visible: true }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current).toEqual({ _tag: "Failed" });
    });
  });
});
