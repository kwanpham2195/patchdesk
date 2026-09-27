// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import { useInsightRunControls } from "../../src/renderer/src/hooks/use-insight-run-controls";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import { projection, providerCatalog } from "./review-workbench-fixtures";

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
        source: { kind: "local_branch", branch: "main", baseBranch: "develop" },
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
