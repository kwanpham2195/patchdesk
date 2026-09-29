// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import type { DesktopResponse } from "../../src/main/ipc-contract";
import { useInsightRunControls } from "../../src/renderer/src/hooks/use-insight-run-controls";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import type { ReviewWorkbenchPatch } from "../../src/renderer/src/flows/use-review-observation";
import {
  projection,
  providerCatalog,
  withAnalysis,
} from "./review-workbench-fixtures";

let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
  window.localStorage.clear();
});

const missingSpec = {
  intent: { kind: "file", path: "docs/spec.md" },
  setting: { kind: "file", path: "docs/spec.md" },
} as const;

/** A working-tree Review holding `changeIntent`. */
function localReview(
  changeIntent: WorkbenchResponse["changeIntent"],
): WorkbenchResponse {
  const base = projection();
  // SAFETY: fixture data in the wire shape `parseWorkbenchResponse` accepts; the working-tree source replaces the pull request fields.
  return projection({
    ...base,
    session: {
      ...base.session,
      key: {
        ...base.session.key,
        source: {
          kind: "local_branch",
          branch: "main",
          baseRef: "refs/heads/develop",
        },
      },
    },
    pullRequest: undefined,
    changeIntent,
  } as never);
}

/** Starts an Analysis from the run dialog and waits for the main process to refuse it over its spec file. */
async function refusedAnalysisStart() {
  desktop = installDesktopDouble({
    // SAFETY: the provider catalog fixture is JSON-compatible data.
    "/v1/insight-providers": () =>
      success(structuredClone(providerCatalog) as RawJsonValue),
    "/v1/reviews/insights/analysis/run": () =>
      failure({ error: "change_intent_file_missing" }, 409),
  });
  const rendered = renderHook(
    ({ workbench }) =>
      useInsightRunControls({
        workbench,
        profileId: "profile",
        reviewId: "review-42",
        initialInsight: "analysis",
        selectedInsight: "analysis",
        onWorkbenchReplace: () => undefined,
        onWorkbenchPatch: () => undefined,
      }),
    { initialProps: { workbench: localReview(missingSpec) } },
  );
  await waitFor(() =>
    expect(rendered.result.current.configuration.catalog).toBeDefined(),
  );
  act(() => rendered.result.current.openRunDialog("run"));
  act(() => rendered.result.current.confirmRun());
  await waitFor(() =>
    expect(rendered.result.current.analysisRun.requestFailure).toBe(
      "change_intent_file_missing",
    ),
  );
  return rendered;
}

describe("useInsightRunControls start refusal", () => {
  it("drops a spec-file refusal once the maintainer changes the Change intent", async () => {
    const { result, rerender } = await refusedAnalysisStart();

    rerender({
      workbench: localReview({
        intent: { kind: "file", path: "docs/specs/spec.md" },
        setting: { kind: "file", path: "docs/specs/spec.md" },
      }),
    });

    expect(result.current.analysisRun.requestFailure).toBeUndefined();
    expect(result.current.analysisRun.error).toBe(false);
    expect(result.current.configuration.runDialogType).toBe("analysis");
  });

  it("drops a spec-file refusal once Refresh moves the Review to a new session", async () => {
    const { result, rerender } = await refusedAnalysisStart();
    const refreshed = localReview(missingSpec);

    rerender({
      workbench: {
        ...refreshed,
        session: { ...refreshed.session, id: "session-b" },
      },
    });

    expect(result.current.analysisRun.requestFailure).toBeUndefined();
  });

  it("opens the run dialog again without the refusal of the last start", async () => {
    const { result } = await refusedAnalysisStart();

    act(() => result.current.closeRunDialog());
    act(() => result.current.openRunDialog("run"));

    expect(result.current.configuration.runDialogType).toBe("analysis");
    expect(result.current.analysisRun.requestFailure).toBeUndefined();
  });
});

describe("useInsightRunControls Finding restore", () => {
  /** Renders the hook on a Review whose one Finding is dismissed, answering the Review reload with `load`. */
  function renderRestore(load: () => DesktopResponse) {
    const opened = withAnalysis("actionable");
    const retained = opened.insights.analysis.retained;
    const finding = retained?.value.findings[0];
    if (retained === undefined || finding === undefined)
      throw new Error("expected a retained Analysis Finding");
    const dismissed = {
      ...finding,
      disposition: "dismissed" as const,
      dismissalReason: "Covered elsewhere",
    };
    const workbench: WorkbenchResponse = {
      ...opened,
      insights: {
        ...opened.insights,
        analysis: {
          ...opened.insights.analysis,
          retained: {
            ...retained,
            value: { ...retained.value, findings: [dismissed] },
          },
        },
      },
    };
    desktop = installDesktopDouble({
      // SAFETY: the provider catalog fixture is JSON-compatible data.
      "/v1/insight-providers": () =>
        success(structuredClone(providerCatalog) as RawJsonValue),
      [`/v1/reviews/insights/analysis/findings/${finding.id}/restore`]: () =>
        success({ findingId: finding.id, status: "open" }),
      "/v1/reviews/load": load,
    });
    const patches: ReviewWorkbenchPatch[] = [];
    const { result } = renderHook(() =>
      useInsightRunControls({
        workbench,
        profileId: "profile",
        reviewId: "review-42",
        initialInsight: "analysis",
        selectedInsight: "analysis",
        onWorkbenchReplace: () => undefined,
        onWorkbenchPatch: (patch) => patches.push(patch),
      }),
    );
    return { dismissed, patches, result };
  }

  it("takes merge readiness and Finding actions from the reloaded Review after a Restore", async () => {
    const blocked: WorkbenchResponse["mergeReadiness"] = {
      _tag: "Blocked",
      blockers: ["analysis_finding"],
      warnings: [],
    };
    const opened = withAnalysis("actionable");
    const reloaded: WorkbenchResponse = { ...opened, mergeReadiness: blocked };
    const { dismissed, patches, result } = renderRestore(() =>
      // SAFETY: the projection fixture is plain JSON data; the bridge carries it as the raw body the renderer parses.
      success(reloaded as RawJsonValue),
    );

    const outcome = await act(() => result.current.restoreFinding(dismissed));

    expect(outcome).toBe("restored");
    const patch = patches.at(-1);
    expect(patch?.mergeReadiness).toEqual(blocked);
    expect(patch?.analysisReviewActions?.findings[dismissed.id]).toEqual({
      state: "actionable",
    });
    expect(
      patch?.insights?.analysis?.retained?.value.findings[0]?.disposition,
    ).not.toBe("dismissed");
  });

  it("shows a confirmed Restore as open and asks for a refresh when the Review reload fails", async () => {
    const { dismissed, patches, result } = renderRestore(() =>
      failure({ error: "storage_unavailable" }, 503),
    );

    const outcome = await act(() => result.current.restoreFinding(dismissed));

    expect(outcome).toBe("refresh_needed");
    const restored =
      patches.at(-1)?.insights?.analysis?.retained?.value.findings[0];
    expect(restored?.disposition).toBe("open");
    expect(restored?.dismissalReason).toBeUndefined();
  });
});
