// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PullRequestRef } from "../../src/domain/pull-request";
import type { NavigationState } from "../../src/renderer/src/hooks/use-app-navigation";
import { useDesktopNotificationClicks } from "../../src/renderer/src/hooks/use-desktop-notifications";
import type { AppDestination } from "../../src/renderer/src/routes";
import {
  installDesktopDouble,
  type DesktopDouble,
} from "./fake-desktop-response";

let installed: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  installed?.restore();
  installed = undefined;
});

type Props = {
  readonly destination: AppDestination;
  readonly navigationState: NavigationState;
};

function render(initialProps: Props) {
  const double = installDesktopDouble({});
  installed = double;
  const navigate = vi.fn<(next: AppDestination) => void>();
  const openPullRequest = vi.fn<(ref: PullRequestRef) => void>();
  const hook = renderHook(
    (props: Props) =>
      useDesktopNotificationClicks({
        enabled: true,
        navigate,
        openPullRequest,
        ...props,
      }),
    { initialProps },
  );
  return { double, navigate, openPullRequest, hook };
}

const onReview = (reviewId: string): AppDestination => ({
  kind: "workbench",
  reviewId,
});

describe("useDesktopNotificationClicks", () => {
  it("opens an Insight notification's Review on that Insight's reader, through the guarded navigate", () => {
    const { double, navigate, hook } = render({
      destination: { kind: "dashboard" },
      navigationState: "clear",
    });

    act(() =>
      double.sendNotificationClick({
        kind: "review",
        reviewId: "r1",
        insightType: "analysis",
      }),
    );

    expect(hook.result.current).toMatchObject({
      reviewId: "r1",
      state: { activeTab: "insights", insightDetail: "analysis" },
    });
    expect(navigate).toHaveBeenCalledWith(onReview("r1"));
  });

  it("selects the Insight on the Review already on screen, asking the workbench to remount with it", () => {
    const { double, navigate, hook } = render({
      destination: onReview("r1"),
      navigationState: "clear",
    });

    act(() =>
      double.sendNotificationClick({
        kind: "review",
        reviewId: "r1",
        insightType: "walkthrough",
      }),
    );
    const first = hook.result.current;
    act(() =>
      double.sendNotificationClick({
        kind: "review",
        reviewId: "r1",
        insightType: "walkthrough",
      }),
    );

    expect(first).toMatchObject({
      reviewId: "r1",
      state: { activeTab: "insights", insightDetail: "walkthrough" },
    });
    expect(hook.result.current?.generation).not.toBe(first?.generation);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("leaves the Review on screen untouched while a draft or write holds it", () => {
    const { double, hook } = render({
      destination: onReview("r1"),
      navigationState: "dirty_draft",
    });

    act(() =>
      double.sendNotificationClick({
        kind: "review",
        reviewId: "r1",
        insightType: "analysis",
      }),
    );

    expect(hook.result.current).toBeUndefined();
  });

  it("leaves no restore state behind when the draft guard parks the navigation", () => {
    const { double, navigate, hook } = render({
      destination: onReview("r0"),
      navigationState: "dirty_draft",
    });

    act(() =>
      double.sendNotificationClick({
        kind: "review",
        reviewId: "r1",
        insightType: "analysis",
      }),
    );

    expect(navigate).toHaveBeenCalledWith(onReview("r1"));
    expect(hook.result.current).toBeUndefined();
  });

  it("forgets the Insight selection once the maintainer leaves that Review", () => {
    const { double, hook } = render({
      destination: { kind: "dashboard" },
      navigationState: "clear",
    });
    act(() =>
      double.sendNotificationClick({
        kind: "review",
        reviewId: "r1",
        insightType: "analysis",
      }),
    );
    hook.rerender({ destination: onReview("r1"), navigationState: "clear" });
    expect(hook.result.current?.reviewId).toBe("r1");

    hook.rerender({
      destination: { kind: "dashboard" },
      navigationState: "clear",
    });

    expect(hook.result.current).toBeUndefined();
  });

  it("opens a write-recovery notification's Review where it was left", () => {
    const { double, navigate, hook } = render({
      destination: { kind: "dashboard" },
      navigationState: "clear",
    });

    act(() => double.sendNotificationClick({ kind: "review", reviewId: "r2" }));

    expect(hook.result.current).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith(onReview("r2"));
  });

  it("opens a watched pull request's notification through the palette's open path", () => {
    const { double, navigate, openPullRequest, hook } = render({
      destination: onReview("r1"),
      navigationState: "clear",
    });
    const pullRequest = {
      host: "github.com",
      owner: "acme",
      repo: "widgets",
      number: 7,
    };

    act(() =>
      double.sendNotificationClick({ kind: "pullRequest", pullRequest }),
    );

    expect(openPullRequest).toHaveBeenCalledWith(pullRequest);
    expect(navigate).not.toHaveBeenCalled();
    expect(hook.result.current).toBeUndefined();
  });
});
