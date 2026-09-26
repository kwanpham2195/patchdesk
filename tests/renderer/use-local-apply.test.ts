// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { useLocalApply } from "../../src/renderer/src/flows/use-local-apply";
import {
  failure,
  installDesktopDouble,
  success,
} from "./fake-desktop-response";
import {
  analysisResult,
  callBody,
  callPath,
  patchHash,
  projection,
  sha,
  withAnalysis,
} from "./review-workbench-fixtures";

const APPLY = "/v1/reviews/local-apply";
const RECOVER = "/v1/reviews/local-apply/recover";
let restore: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

/** A working-tree Review whose current Analysis holds one Finding with a suggestion. */
function workingTreeAnalysis(sessionId = "session-a"): WorkbenchResponse {
  const base = withAnalysis("actionable");
  const retained = base.insights.analysis.retained;
  if (retained === undefined) throw new Error("missing Analysis fixture");
  // SAFETY: fixture data in the wire shape `parseWorkbenchResponse` accepts; the working-tree source replaces the pull request fields.
  return projection({
    session: {
      id: sessionId,
      key: {
        ...base.session.key,
        source: { kind: "working_tree", branch: "main" },
      },
    },
    pullRequest: undefined,
    insights: {
      ...base.insights,
      analysis: {
        ...base.insights.analysis,
        retained: {
          ...retained,
          sessionId,
          value: {
            ...analysisResult,
            findings: analysisResult.findings.map((finding) => ({
              ...finding,
              suggestedReplacement: { code: "guard();" },
            })),
          },
        },
      },
    },
  } as never);
}

function renderApply(workbench: WorkbenchResponse) {
  const onWorkbenchReplace = vi.fn();
  const rendered = renderHook(() =>
    useLocalApply({
      workbench,
      onWorkbenchReplace,
      onWorkbenchPatch: () => undefined,
    }),
  );
  return { ...rendered, onWorkbenchReplace };
}

describe("useLocalApply", () => {
  it("sends the selected Findings by identity and adopts the next session", async () => {
    const next = workingTreeAnalysis("session-b");
    const double = installDesktopDouble({
      // SAFETY: the projection fixture is plain JSON data; the bridge carries it as the raw body the renderer parses.
      [APPLY]: () =>
        success({ status: "applied", workbench: next as RawJsonValue }),
    });
    restore = double.restore;
    const { result, onWorkbenchReplace } = renderApply(workingTreeAnalysis());

    act(() => result.current?.setSelected("finding-1", true));
    await act(async () => result.current?.apply());

    const call = double.request.mock.calls.find(
      ([input]) => callPath(input) === APPLY,
    );
    expect(callBody(call?.[0])).toEqual({
      profileId: "profile",
      reviewId: "review-42",
      runId: "insight-analysis-1-fixture",
      findingIds: ["finding-1"],
      expected: { sessionId: "session-a", headSha: sha, patchHash },
    });
    expect(onWorkbenchReplace).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ id: "session-b" }),
      }),
    );
  });

  it("keeps the selection and reports why a refused Apply wrote nothing", async () => {
    const double = installDesktopDouble({
      [APPLY]: () => failure({ error: "revision_changed" }, 409),
    });
    restore = double.restore;
    const { result, onWorkbenchReplace } = renderApply(workingTreeAnalysis());

    act(() => result.current?.setSelected("finding-1", true));
    await act(async () => result.current?.apply());

    expect(result.current?.refusal).toBeDefined();
    expect(result.current?.selectedIds.has("finding-1")).toBe(true);
    expect(result.current?.lock).toBeUndefined();
    expect(onWorkbenchReplace).not.toHaveBeenCalled();
  });

  it("keeps Apply disabled with its reason after a RevisionChanged refusal until Refresh moves the Review on", async () => {
    restore = installDesktopDouble({
      [APPLY]: () => failure({ error: "revision_changed" }, 409),
    }).restore;
    let workbench = workingTreeAnalysis();
    const { result, rerender } = renderHook(() =>
      useLocalApply({
        workbench,
        onWorkbenchReplace: () => undefined,
        onWorkbenchPatch: (patch) => {
          // SAFETY: the patch carries whole top-level fields, as the app's merge applies them.
          workbench = { ...workbench, ...patch } as WorkbenchResponse;
        },
      }),
    );

    act(() => result.current?.setSelected("finding-1", true));
    await act(async () => result.current?.apply());
    rerender();
    act(() => result.current?.setSelected("finding-1", false));
    act(() => result.current?.setSelected("finding-1", true));

    expect(result.current?.blocked).toBe(true);
    expect(result.current?.refusal).toBeDefined();

    workbench = workingTreeAnalysis("session-b");
    rerender();

    expect(result.current?.blocked).toBe(false);
    expect(result.current?.refusal).toBeUndefined();
  });

  it("locks Apply after an unknown outcome until a check finds nothing applied", async () => {
    const double = installDesktopDouble({
      [APPLY]: () => success({ status: "outcome_unknown" }),
      [RECOVER]: () => success({ decision: "not_applied" }),
    });
    restore = double.restore;
    const { result } = renderApply(workingTreeAnalysis());

    act(() => result.current?.setSelected("finding-1", true));
    await act(async () => result.current?.apply());
    expect(result.current?.lock).toBe("outcome_unknown");

    await act(async () => result.current?.check());

    expect(result.current?.lock).toBeUndefined();
    expect(
      double.request.mock.calls.filter(([input]) => callPath(input) === APPLY),
    ).toHaveLength(1);
  });

  it("offers nothing on a pull request Review", () => {
    restore = installDesktopDouble({}).restore;

    expect(
      renderApply(withAnalysis("actionable")).result.current,
    ).toBeUndefined();
  });
});
