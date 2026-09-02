// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import type { RunDirectCommand } from "../../src/renderer/src/flows/use-review-observation";
import {
  useDirectSummaryActions,
  type DirectSummaryActionsResult,
} from "../../src/renderer/src/flows/use-direct-summary-actions";
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
} from "./review-workbench-fixtures";

/**
 * `useDirectSummaryActions` owns which direct-summary state the maintainer
 * sees after a write: the fresh submit result, the recovery lock an
 * unconfirmed write leaves, and when a newly projected Review clears both.
 * The server always projects `directSummary: { state: "idle" }`, so the
 * override decision below is the whole reason a confirmed receipt stays
 * visible. `summary-review-dialog.ui.test.tsx` owns how the dialog renders
 * those states; the mounted flow test owns the wiring.
 */

const SUBMIT = "/v1/reviews/direct-summary/submit";
const RECOVER = "/v1/reviews/direct-summary/recover";

const confirmed = {
  directSummary: {
    state: "confirmed",
    receipt: { reviewId: "9002", event: "COMMENT" },
  },
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

function installSummaryDouble(answers: {
  readonly submit?: Answer;
  readonly submitFailure?: () => ReturnType<typeof failure>;
  readonly recover?: Answer;
}) {
  const answer = async (route: Answer | undefined, path: string) => {
    if (route === undefined)
      throw new Error(`this case scripted no answer for ${path}`);
    // SAFETY: every scripted body is JSON fixture data; the answer type is
    // `unknown` only because each case shapes its own payload.
    return success((await route()) as RawJsonValue);
  };
  const double = installDesktopDouble({
    [SUBMIT]: async () =>
      answers.submitFailure === undefined
        ? await answer(answers.submit, SUBMIT)
        : answers.submitFailure(),
    [RECOVER]: async () => await answer(answers.recover, RECOVER),
  });
  restore = double.restore;
  return double.request;
}

function renderDirectSummary(workbench: WorkbenchResponse) {
  const appendRecentWrites = vi.fn();
  const observeConfirmedDirectSummary = vi.fn(async () => undefined);
  // A typed passthrough rather than a `vi.fn`: `RunDirectCommand` is generic
  // over the operation's result, and a mock erases that generic.
  const insideDirectCommand: boolean[] = [];
  const runDirectCommand: RunDirectCommand = async (operation) => {
    insideDirectCommand.push(true);
    return await operation();
  };
  const rendered = renderHook(
    (props: { readonly workbench: WorkbenchResponse }) =>
      useDirectSummaryActions({
        workbench: props.workbench,
        runDirectCommand,
        appendRecentWrites,
        observeConfirmedDirectSummary,
      }),
    { initialProps: { workbench } },
  );
  return {
    ...rendered,
    appendRecentWrites,
    observeConfirmedDirectSummary,
    insideDirectCommand,
  };
}

function panelOf(result: {
  readonly current: DirectSummaryActionsResult;
}): NonNullable<DirectSummaryActionsResult["directSummary"]> {
  const panel = result.current.directSummary;
  if (panel === undefined) throw new Error("expected a direct-summary panel");
  return panel;
}

const reviewable = projection({
  pendingReview: pending("none"),
  directSummaryDecision: "allowed",
});

describe("useDirectSummaryActions submit", () => {
  it("submits through runDirectCommand with the represented revision", async () => {
    const request = installSummaryDouble({ submit: () => confirmed });
    const { result, insideDirectCommand } = renderDirectSummary(reviewable);
    expect(panelOf(result).approvalCapability).toBe("allowed");

    await act(async () => {
      await panelOf(result).onSubmit("COMMENT", "Confirmed body");
    });

    expect(insideDirectCommand).toEqual([true]);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: SUBMIT,
        body: {
          profileId: "profile",
          reviewId: "review-42",
          expected: { sessionId: "session-a", headSha: sha, patchHash },
          event: "COMMENT",
          body: "Confirmed body",
        },
      }),
    );
  });

  it("journals the confirmed receipt and observes it exactly once", async () => {
    installSummaryDouble({ submit: () => confirmed });
    const { result, appendRecentWrites, observeConfirmedDirectSummary } =
      renderDirectSummary(reviewable);

    await act(async () => {
      await panelOf(result).onSubmit("COMMENT", "Confirmed body");
    });
    expect(appendRecentWrites).toHaveBeenCalledWith({
      _tag: "DirectSummaryReview",
      reviewId: "9002",
    });
    expect(observeConfirmedDirectSummary).toHaveBeenCalledWith("9002");

    await act(async () => {
      await panelOf(result).onSubmit("COMMENT", "Confirmed body");
    });
    expect(observeConfirmedDirectSummary).toHaveBeenCalledTimes(1);
  });

  it("keeps the confirmed receipt visible over the projection's idle state", async () => {
    installSummaryDouble({
      submit: () => ({
        directSummary: {
          state: "confirmed",
          receipt: { reviewId: "9002", event: "APPROVE" },
        },
      }),
    });
    const { result, rerender } = renderDirectSummary(reviewable);
    expect(panelOf(result).state).toBe("idle");

    await act(async () => {
      await panelOf(result).onSubmit("APPROVE", "Approve this");
    });

    expect(panelOf(result).state).toBe("confirmed");
    expect(panelOf(result).receipt).toEqual({
      reviewId: "9002",
      event: "APPROVE",
    });

    // The server keeps projecting `idle`; re-rendering on it must not reset
    // the override, or the dialog would fall back to its submit form.
    rerender({ workbench: reviewable });
    expect(panelOf(result).state).toBe("confirmed");
  });

  it("clears the override once the projection carries a different receipt", async () => {
    installSummaryDouble({ submit: () => confirmed });
    const { result, rerender } = renderDirectSummary(reviewable);
    await act(async () => {
      await panelOf(result).onSubmit("COMMENT", "Confirmed body");
    });
    expect(panelOf(result).state).toBe("confirmed");

    rerender({
      workbench: projection({
        pendingReview: pending("none"),
        directSummary: {
          state: "confirmed",
          receipt: { reviewId: "9500", event: "APPROVE" },
        },
      }),
    });

    expect(panelOf(result).receipt).toEqual({
      reviewId: "9500",
      event: "APPROVE",
    });
  });
});

describe("useDirectSummaryActions recovery", () => {
  it("locks on an outcome-unknown submit until an explicit recovery", async () => {
    const request = installSummaryDouble({
      submitFailure: () => failure({ error: "outcome_unknown" }, 500),
      recover: () => confirmed,
    });
    const { result, observeConfirmedDirectSummary } =
      renderDirectSummary(reviewable);

    await act(async () => {
      await expect(
        panelOf(result).onSubmit("COMMENT", "Unconfirmed body"),
      ).rejects.toThrow();
    });
    expect(panelOf(result).state).toBe("recovery_required");
    expect(panelOf(result).recoveryResolution).toBe("check_required");
    expect(panelOf(result).error).toBeTruthy();

    await act(async () => {
      await panelOf(result).onRecover();
    });
    expect(panelOf(result).state).toBe("confirmed");
    expect(panelOf(result).error).toBeUndefined();
    expect(observeConfirmedDirectSummary).toHaveBeenCalledWith("9002");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: RECOVER,
        body: { profileId: "profile", reviewId: "review-42" },
      }),
    );
  });

  it.each([
    ["missing projection", {}],
    ["missing receipt", { directSummary: { state: "confirmed" } }],
    [
      "wrong state tag",
      {
        directSummary: {
          state: "complete",
          receipt: confirmed.directSummary.receipt,
        },
      },
    ],
    [
      "wrong receipt id",
      {
        directSummary: {
          state: "confirmed",
          receipt: { reviewId: 9002, event: "COMMENT" },
        },
      },
    ],
    [
      "wrong receipt event",
      {
        directSummary: {
          state: "confirmed",
          receipt: { reviewId: "9002", event: "COMMENTED" },
        },
      },
    ],
    ["event that does not match the submitted decision", confirmed],
    ["extra response field", { ...confirmed, unexpected: true }],
    ["idle submit result", { directSummary: { state: "idle" } }],
  ])("locks recovery for a %s 2xx response", async (_case, response) => {
    installSummaryDouble({ submit: () => response });
    const { result, appendRecentWrites } = renderDirectSummary(reviewable);

    await act(async () => {
      await expect(
        panelOf(result).onSubmit(
          _case === "event that does not match the submitted decision"
            ? "APPROVE"
            : "COMMENT",
          "Body",
        ),
      ).rejects.toThrow(/Invalid direct summary review response/);
    });
    expect(panelOf(result).state).toBe("recovery_required");
    expect(panelOf(result).recoveryResolution).toBe("check_required");
    expect(panelOf(result).error).toBeTruthy();
    expect(appendRecentWrites).not.toHaveBeenCalled();
  });

  it("admits only one submit in the same tick", async () => {
    let resolveSubmit: ((value: typeof confirmed) => void) | undefined;
    const response = new Promise<typeof confirmed>((resolve) => {
      resolveSubmit = resolve;
    });
    const request = installSummaryDouble({ submit: () => response });
    const { result } = renderDirectSummary(reviewable);

    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    await act(async () => {
      first = panelOf(result).onSubmit("COMMENT", "First");
      second = panelOf(result).onSubmit("COMMENT", "Second");
      await Promise.resolve();
    });
    expect(request).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSubmit?.(confirmed);
      await Promise.all([first, second]);
    });
  });

  it("keeps recovery checks single-flight and preserves the server resolution", async () => {
    let resolveRecovery:
      | ((value: {
          readonly directSummary: {
            readonly state: "recovery_required";
            readonly resolution: "manual_resolution_required";
          };
        }) => void)
      | undefined;
    const response = new Promise<{
      readonly directSummary: {
        readonly state: "recovery_required";
        readonly resolution: "manual_resolution_required";
      };
    }>((resolve) => {
      resolveRecovery = resolve;
    });
    const request = installSummaryDouble({ recover: () => response });
    const recovering = projection({
      pendingReview: pending("none"),
      directSummary: {
        state: "recovery_required",
        resolution: "check_required",
      },
    });
    const { result } = renderDirectSummary(recovering);

    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    await act(async () => {
      first = panelOf(result).onRecover();
      second = panelOf(result).onRecover();
      await Promise.resolve();
    });
    expect(request).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRecovery?.({
        directSummary: {
          state: "recovery_required",
          resolution: "manual_resolution_required",
        },
      });
      await Promise.all([first, second]);
    });
    expect(panelOf(result).state).toBe("recovery_required");
    expect(panelOf(result).recoveryResolution).toBe(
      "manual_resolution_required",
    );
  });
});

describe("useDirectSummaryActions eligibility", () => {
  it("offers no panel while a pending review is still open", () => {
    installSummaryDouble({});
    const { result } = renderDirectSummary(
      projection({ pendingReview: pending("pending") }),
    );

    expect(result.current.directSummary).toBeUndefined();
  });

  it("reports an unknown approval capability when the projection omits it", () => {
    installSummaryDouble({});
    const { result } = renderDirectSummary(
      projection({ pendingReview: pending("none") }),
    );

    expect(panelOf(result).approvalCapability).toBe("unknown");
  });
});
