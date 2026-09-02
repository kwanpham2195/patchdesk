// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import { useReviewWriteRecovery } from "../../src/renderer/src/flows/use-review-write-recovery";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import { projection } from "./review-workbench-fixtures";

let desktop: DesktopDouble | undefined;
afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
});

function renderRecovery(workbench = projection(), replace = vi.fn()) {
  return {
    ...renderHook((value) => useReviewWriteRecovery(value), {
      initialProps: { workbench, onWorkbenchReplace: replace },
    }),
    replace,
  };
}

describe("useReviewWriteRecovery", () => {
  it("owns reload-persisted and ephemeral recovery locks", () => {
    const durable = renderRecovery(
      projection({
        remoteWriteRecovery: {
          operation: "Reply",
          resolution: "check_required",
        },
      }),
    );
    expect(durable.result.current).toMatchObject({
      githubWritesLocked: true,
      recovery: { operation: "Reply", resolution: "check_required" },
    });
    durable.unmount();

    const ephemeral = renderRecovery();
    act(() => ephemeral.result.current.requireRecovery("EditComment"));
    expect(ephemeral.result.current).toMatchObject({
      githubWritesLocked: true,
      recovery: {
        operation: "EditComment",
        resolution: "check_required",
      },
    });
  });

  it("uses only the recovery route, strictly parses it, and canonically replaces the workbench", async () => {
    const next = projection({
      pullRequest: { ...projection().pullRequest, title: "Recovered" },
    } as never);
    desktop = installDesktopDouble({
      // SAFETY: the validated workbench fixture is JSON-only renderer data.
      "/v1/reviews/write/recover": () => success(next as RawJsonValue),
    });
    const rendered = renderRecovery(
      projection({
        remoteWriteRecovery: {
          operation: "CreateComment",
          resolution: "check_required",
        },
      }),
    );

    await act(async () => rendered.result.current.checkGitHubAgain());

    expect(rendered.replace).toHaveBeenCalledWith(next);
    expect(desktop.request).toHaveBeenCalledWith({
      path: "/v1/reviews/write/recover",
      method: "POST",
      body: { profileId: "profile", reviewId: "review-42" },
    });
    expect(
      desktop.request.mock.calls.filter(
        ([input]) => "path" in input && input.path.includes("command"),
      ),
    ).toHaveLength(0);
  });

  it("keeps the lock with bounded errors for malformed and failed checks", async () => {
    let malformed = true;
    desktop = installDesktopDouble({
      "/v1/reviews/write/recover": () =>
        malformed
          ? success({ state: "review" })
          : failure({ error: "storage", detail: "not renderer safe" }),
    });
    const rendered = renderRecovery();
    act(() => rendered.result.current.requireRecovery("DeleteComment"));

    await act(async () => rendered.result.current.checkGitHubAgain());
    expect(rendered.result.current).toMatchObject({
      githubWritesLocked: true,
      recoveryError: "invalid_response",
    });
    expect(rendered.replace).not.toHaveBeenCalled();

    malformed = false;
    await act(async () => rendered.result.current.checkGitHubAgain());
    expect(rendered.result.current).toMatchObject({
      githubWritesLocked: true,
      recoveryError: "check_failed",
    });
  });

  it("admits one synchronous check and exposes no check for manual resolution", async () => {
    let release!: (value: ReturnType<typeof success>) => void;
    const response = new Promise<ReturnType<typeof success>>((resolve) => {
      release = resolve;
    });
    desktop = installDesktopDouble({
      "/v1/reviews/write/recover": () => response,
    });
    const rendered = renderRecovery(
      projection({
        remoteWriteRecovery: {
          operation: "Reply",
          resolution: "check_required",
        },
      }),
    );

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = rendered.result.current.checkGitHubAgain();
      second = rendered.result.current.checkGitHubAgain();
    });
    expect(first).toBe(second);
    expect(rendered.result.current.checking).toBe(true);
    expect(desktop.request).toHaveBeenCalledTimes(1);
    await act(async () => release(success(projection() as never)));
    await first;

    rendered.rerender({
      workbench: projection({
        remoteWriteRecovery: {
          operation: "Reply",
          resolution: "manual_resolution_required",
        },
      }),
      onWorkbenchReplace: rendered.replace,
    });
    await act(async () => rendered.result.current.checkGitHubAgain());
    expect(desktop.request).toHaveBeenCalledTimes(1);
  });
});
