// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import type {
  ReviewWorkbenchPatch,
  RunDirectCommand,
} from "../../src/renderer/src/flows/use-review-observation";
import {
  usePendingReviewActions,
  type PendingReviewActionsResult,
} from "../../src/renderer/src/flows/use-pending-review-actions";
import {
  failure,
  installDesktopDouble,
  success,
} from "./fake-desktop-response";
import {
  pending,
  projection,
  sha,
  patchHash,
  type DeferredResolve,
} from "./review-workbench-fixtures";

/**
 * `usePendingReviewActions` owns the lock and recovery decisions around a
 * GitHub pending review: which command goes out, when an unconfirmed write
 * forces recovery, and what a recovery pass replaces. Driving it through
 * `renderHook` names those decisions directly. It cannot see how
 * `ReviewWorkbenchFlow` hands it `runDirectCommand`; the mounted flow test
 * keeps that proof.
 */

const COMMAND = "/v1/reviews/pending-review/command";
const RECOVER = "/v1/reviews/pending-review/recover";
const LOAD = "/v1/reviews/load";

const anchor = {
  path: "src/a.ts",
  startLine: 1,
  line: 1,
  side: "new" as const,
};

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

/**
 * Answers one loopback path. Each case scripts a differently-shaped fixture
 * body, so `unknown` is the honest type here, not an unparsed I/O value.
 */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- see comment above
type Answer = () => Promise<unknown> | unknown;

function installPendingDouble(answers: {
  readonly command?: Answer;
  readonly commandFailure?: () => ReturnType<typeof failure>;
  readonly recover?: Answer;
  readonly load?: Answer;
}) {
  // SAFETY: every scripted body below is JSON fixture data; the answer type is
  // `unknown` only because each case shapes its own payload.
  const answer = async (route: Answer | undefined, path: string) => {
    if (route === undefined)
      throw new Error(`this case scripted no answer for ${path}`);
    return success((await route()) as RawJsonValue);
  };
  const double = installDesktopDouble({
    "/v1/logs": () => success(null),
    [COMMAND]: async () =>
      answers.commandFailure === undefined
        ? await answer(answers.command, COMMAND)
        : answers.commandFailure(),
    [RECOVER]: async () => await answer(answers.recover, RECOVER),
    [LOAD]: async () => await answer(answers.load, LOAD),
  });
  restore = double.restore;
  return double.request;
}

function renderPendingReview(workbench: WorkbenchResponse) {
  const replace = vi.fn();
  const patch = vi.fn<(value: ReviewWorkbenchPatch) => void>();
  const appendRecentWrites = vi.fn();
  const observeConfirmedReviewWrite = vi.fn(async () => undefined);
  // A typed passthrough rather than a `vi.fn`: `RunDirectCommand` is generic
  // over the operation's result, and a mock erases that generic.
  const insideDirectCommand: boolean[] = [];
  const runDirectCommand: RunDirectCommand = async (operation) => {
    insideDirectCommand.push(true);
    return await operation();
  };
  const rendered = renderHook(
    (props: { readonly workbench: WorkbenchResponse }) =>
      usePendingReviewActions({
        workbench: props.workbench,
        onWorkbenchReplace: replace,
        onWorkbenchPatch: patch,
        runDirectCommand,
        appendRecentWrites,
        observeConfirmedReviewWrite,
      }),
    { initialProps: { workbench } },
  );
  return {
    ...rendered,
    replace,
    patch,
    appendRecentWrites,
    observeConfirmedReviewWrite,
    insideDirectCommand,
  };
}

function composerOf(result: {
  readonly current: PendingReviewActionsResult;
}): NonNullable<PendingReviewActionsResult["pendingReviewComposer"]> {
  const composer = result.current.pendingReviewComposer;
  if (composer === undefined) throw new Error("expected a composer");
  return composer;
}

function panelOf(result: {
  readonly current: PendingReviewActionsResult;
}): NonNullable<PendingReviewActionsResult["pendingReview"]> {
  const panel = result.current.pendingReview;
  if (panel === undefined) throw new Error("expected a pending-review panel");
  return panel;
}

describe("usePendingReviewActions commands", () => {
  it("sends Start through runDirectCommand with the represented revision", async () => {
    const next = pending("pending");
    const request = installPendingDouble({
      command: () => ({ pendingReview: next }),
    });
    const { result, patch, insideDirectCommand } = renderPendingReview(
      projection({ pendingReview: pending("none") as never }),
    );

    await act(async () => {
      await composerOf(result).onStartReview(anchor, "Start with this finding");
    });

    expect(insideDirectCommand).toEqual([true]);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: COMMAND,
        body: {
          profileId: "profile",
          reviewId: "review-42",
          command: {
            _tag: "Start",
            expected: { sessionId: "session-a", headSha: sha, patchHash },
            anchor,
            body: "Start with this finding",
          },
        },
      }),
    );
    expect(patch).toHaveBeenCalledWith({ pendingReview: next });
  });

  it("journals only the thread ids a command newly created", async () => {
    const created = {
      state: "pending",
      count: 2,
      review: {
        nodeId: "PRR_1",
        headSha: sha,
        comments: [
          {
            threadId: "PRRT_1",
            body: "Finding",
            path: "src/a.ts",
            startLine: 1,
            line: 1,
            side: "new",
          },
          {
            threadId: "PRRT_2",
            body: "Second",
            path: "src/a.ts",
            startLine: 2,
            line: 2,
            side: "new",
          },
        ],
      },
    };
    installPendingDouble({ command: () => ({ pendingReview: created }) });
    const { result, appendRecentWrites } = renderPendingReview(
      projection({ pendingReview: pending("pending") as never }),
    );

    await act(async () => {
      await composerOf(result).onAddReviewComment(
        "PRR_1",
        { ...anchor, startLine: 2, line: 2 },
        "Second",
      );
    });

    expect(appendRecentWrites).toHaveBeenCalledWith([
      { _tag: "PendingThread", threadId: "PRRT_2" },
    ]);
  });

  it("journals the discarded threads and observes a confirmed submit", async () => {
    installPendingDouble({
      command: () => ({ pendingReview: { state: "none" } }),
    });
    const { result, appendRecentWrites, observeConfirmedReviewWrite } =
      renderPendingReview(
        projection({ pendingReview: pending("pending") as never }),
      );

    await act(async () => {
      await panelOf(result).onDiscard();
    });
    expect(appendRecentWrites).toHaveBeenCalledWith([
      { _tag: "PendingThread", threadId: "PRRT_1" },
    ]);
    expect(observeConfirmedReviewWrite).not.toHaveBeenCalled();

    await act(async () => {
      await panelOf(result).onSubmit("APPROVE", "Looks good");
    });
    expect(observeConfirmedReviewWrite).toHaveBeenCalledTimes(1);
  });

  it("reports busy for the whole command and clears it afterwards", async () => {
    let release!: DeferredResolve;
    installPendingDouble({
      command: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const { result } = renderPendingReview(
      projection({ pendingReview: pending("none") as never }),
    );
    expect(panelOf(result).busy).toBe(false);

    let settled: Promise<void> | undefined;
    await act(async () => {
      settled = composerOf(result).onStartReview(anchor, "Hanging write");
      await Promise.resolve();
    });
    expect(panelOf(result).busy).toBe(true);

    await act(async () => {
      release({ pendingReview: pending("pending") });
      await settled;
    });
    await waitFor(() => expect(panelOf(result).busy).toBe(false));
  });
});

describe("usePendingReviewActions recovery", () => {
  it("requires recovery after a malformed successful command response", async () => {
    const request = installPendingDouble({
      command: () => ({ pendingReview: {} }),
    });
    const { result, patch } = renderPendingReview(
      projection({ pendingReview: pending("none") as never }),
    );

    await act(async () => {
      await expect(
        composerOf(result).onStartReview(anchor, "Cannot confirm this command"),
      ).rejects.toThrow(/could not confirm this write/i);
    });

    expect(patch).toHaveBeenCalledWith({
      pendingReview: { state: "recovery_required", action: "start" },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("requires recovery after an outcome-unknown command failure", async () => {
    installPendingDouble({
      commandFailure: () => failure({ error: "outcome_unknown" }, 500),
    });
    const { result, patch } = renderPendingReview(
      projection({ pendingReview: pending("pending") as never }),
    );

    await act(async () => {
      await panelOf(result).onSubmit("COMMENT", "Summary");
    });

    expect(patch).toHaveBeenCalledWith({
      pendingReview: { state: "recovery_required", action: "submit" },
    });
    expect(panelOf(result).finishDialogError).toBeTruthy();
  });

  it("reloads the Review once an explicit recovery clears the lock", async () => {
    const reloaded = projection({ pendingReview: pending("none") as never });
    const request = installPendingDouble({
      recover: () => ({ pendingReview: { state: "none" } }),
      load: () => reloaded,
    });
    const { result, replace } = renderPendingReview(
      projection({ pendingReview: pending("unavailable") as never }),
    );

    await act(async () => {
      await panelOf(result).onCheckGitHubAgain();
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: RECOVER,
        body: { profileId: "profile", reviewId: "review-42" },
      }),
    );
    expect(replace).toHaveBeenCalledWith(reloaded);
    expect(panelOf(result).recoveryError).toBeUndefined();
  });

  it("keeps the lock and explains it when recovery still cannot identify the review", async () => {
    const request = installPendingDouble({
      recover: () => ({
        pendingReview: { state: "recovery_required", action: "start" },
      }),
    });
    const { result, replace } = renderPendingReview(
      projection({ pendingReview: pending("unavailable") as never }),
    );

    await act(async () => {
      await panelOf(result).onCheckGitHubAgain();
    });

    expect(replace).not.toHaveBeenCalled();
    expect(panelOf(result).recoveryError).toMatch(/cannot identify the exact/i);
    expect(
      request.mock.calls.filter(
        ([input]) => "path" in input && input.path === LOAD,
      ),
    ).toHaveLength(0);
  });
});

describe("usePendingReviewActions dialog", () => {
  it("prefills the finish dialog with an Analysis-built summary", () => {
    installPendingDouble({});
    const { result } = renderPendingReview(
      projection({ pendingReview: pending("pending") as never }),
    );
    expect(panelOf(result).finishDialogOpen).toBe(false);

    act(() => {
      result.current.openFinishDialogWithSummary("# Review Scope\n");
    });

    expect(panelOf(result).finishDialogOpen).toBe(true);
    expect(panelOf(result).finishDialogInitialSummary).toBe("# Review Scope\n");
  });

  it("offers no composer or panel when the projection carries no pending review", () => {
    installPendingDouble({});
    const { result } = renderPendingReview(
      projection({ pendingReview: undefined }),
    );

    expect(result.current.pendingReviewComposer).toBeUndefined();
    expect(result.current.pendingReview).toBeUndefined();
  });
});
