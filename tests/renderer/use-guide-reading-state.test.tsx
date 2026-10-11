// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RawJsonValue } from "#src/domain/json";
import { buildGuideInventory, retainGuide } from "#src/domain/guide";
import { parseInsightRunId, parseReviewSessionId } from "#src/domain/ids";
import type { GuideReadingState } from "#src/domain/guide-reading-state";
import type { DesktopResponse } from "#src/main/ipc-contract";
import {
  GuideReadingFlushProvider,
  useGuideReadingFlush,
} from "#src/renderer/src/hooks/use-guide-reading-flush";
import { useGuideReadingState } from "#src/renderer/src/hooks/use-guide-reading-state";
import type { ReviewWorkbenchPatch } from "#src/renderer/src/flows/use-review-observation";
import { projection } from "./review-workbench-fixtures";
import {
  failure,
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import { must } from "#tests/services/insight-run-fixture";

const path = "/v1/reviews/insights/guide/reading-state";
const sessionId = must(
  parseReviewSessionId(
    "github.com__octo-org__patchdesk__pr-42__sha-aaaaaaaa__base-00000000__b48f8e2e76ca",
  ),
);
const runId = must(
  parseInsightRunId(
    "insight-guide-1-aaaaaaaaaaaa-github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
  ),
);
const replacedId = must(
  parseInsightRunId(
    "insight-guide-2-aaaaaaaaaaaa-github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
  ),
);
const patch = projection().fullPatch ?? "";
const guide = must(
  retainGuide(
    {
      groups: [
        {
          title: "Behavior",
          explanation: "Recovery.",
          files: [{ fileId: "f1", relevance: "Recovery owner." }],
        },
      ],
    },
    { patchText: patch, inventory: must(buildGuideInventory(patch)) },
  ),
);
const initial: GuideReadingState = {
  runId,
  sessionId,
  version: 0,
  reviewedGroupIds: [],
  expandedAppearances: [],
  anchor: { kind: "top" },
};
function workbench(state = initial) {
  const base = projection();
  return projection({
    insights: {
      ...base.insights,
      guide: {
        status: "outdated",
        artifactStatus: "verified",
        retained: {
          runId: state.runId,
          sessionId,
          headSha: base.revision.reviewedHeadSha,
          generatedAt: "2026-08-01T00:00:00.000Z",
          freshness: "outdated",
          value: guide,
        },
        readingState: state,
      },
    },
  });
}
let desktop: DesktopDouble | undefined;
afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
});
function renderReading(patches: ReviewWorkbenchPatch[], state = initial) {
  return renderHook(
    (model) => ({
      reading: useGuideReadingState(model, (next) => patches.push(next)),
      owner: useGuideReadingFlush(),
    }),
    { initialProps: workbench(state), wrapper: GuideReadingFlushProvider },
  );
}

describe("Guide reading queue", () => {
  it("keeps only one save in flight, coalesces later edits and flushes the latest represented state", async () => {
    const answers: Array<(response: DesktopResponse) => void> = [];
    desktop = installDesktopDouble({
      [path]: () =>
        new Promise<DesktopResponse>((resolve) => answers.push(resolve)),
    });
    const patches: ReviewWorkbenchPatch[] = [];
    const { result } = renderReading(patches);
    act(() =>
      result.current.reading?.edit({
        reviewedGroupIds: ["g1"],
        expandedAppearances: [],
        anchor: { kind: "top" },
      }),
    );
    act(() =>
      result.current.reading?.edit({
        reviewedGroupIds: ["g1"],
        expandedAppearances: [{ groupId: "g1", fileId: "f1" }],
        anchor: { kind: "file", groupId: "g1", fileId: "f1", offset: 20 },
      }),
    );
    act(() =>
      result.current.reading?.edit({
        reviewedGroupIds: [],
        expandedAppearances: [{ groupId: "g1", fileId: "f1" }],
        anchor: { kind: "file", groupId: "g1", fileId: "f1", offset: 35 },
      }),
    );
    await waitFor(() => expect(answers).toHaveLength(1));
    let flushed = false;
    const flushing = result.current.owner.flush().then((saved) => {
      flushed = saved;
    });
    expect(flushed).toBe(false);
    await act(async () =>
      answers[0]?.(
        success({ ...initial, version: 1, reviewedGroupIds: ["g1"] }),
      ),
    );
    await waitFor(() => expect(answers).toHaveLength(2));
    expect(desktop.request.mock.calls[1]?.[0]).toMatchObject({
      path,
      body: {
        profileId: "profile",
        reviewId: "review-42",
        runId,
        sessionId,
        expectedStateVersion: 1,
        state: {
          reviewedGroupIds: [],
          expandedAppearances: [{ groupId: "g1", fileId: "f1" }],
          anchor: { kind: "file", groupId: "g1", fileId: "f1", offset: 35 },
        },
      },
    });
    await act(async () =>
      answers[1]?.(
        success({
          ...initial,
          version: 2,
          expandedAppearances: [{ groupId: "g1", fileId: "f1" }],
          anchor: { kind: "file", groupId: "g1", fileId: "f1", offset: 35 },
        }),
      ),
    );
    await flushing;
    expect(flushed).toBe(true);
    expect(result.current.reading?.progress.anchor).toEqual({
      kind: "file",
      groupId: "g1",
      fileId: "f1",
      offset: 35,
    });
    expect(patches.at(-1)?.insights?.guide?.readingState?.version).toBe(2);
  });

  it("preserves edits after a write failure and lets an explicit Retry confirm them", async () => {
    let fail = true;
    desktop = installDesktopDouble({
      [path]: () =>
        fail
          ? failure({ error: "storage_unavailable" })
          : success({ ...initial, version: 1, reviewedGroupIds: ["g1"] }),
    });
    const { result } = renderReading([]);
    act(() =>
      result.current.reading?.edit({
        reviewedGroupIds: ["g1"],
        expandedAppearances: [],
        anchor: { kind: "top" },
      }),
    );
    await waitFor(() => expect(result.current.reading?.saveFailed).toBe(true));
    expect(await result.current.owner.flush()).toBe(false);
    expect(result.current.reading?.progress.reviewedGroupIds).toEqual(["g1"]);
    fail = false;
    await act(async () => {
      expect(await result.current.reading?.retry()).toBe(true);
    });
    expect(result.current.reading?.saveFailed).toBe(false);
    expect(result.current.reading?.progress.version).toBe(1);
  });

  it("reloads the canonical version on conflict without overwriting it until explicit Retry", async () => {
    let conflict = true;
    const canonical = { ...initial, version: 4, reviewedGroupIds: ["g1"] };
    // SAFETY: workbench constructs a literal JSON fixture; optional projection fields are omitted.
    const canonicalJson = workbench(canonical) as RawJsonValue;
    desktop = installDesktopDouble({
      [path]: () =>
        conflict
          ? failure({ error: "guide_version_conflict" }, 409)
          : success({
              ...initial,
              version: 5,
              expandedAppearances: [{ groupId: "g1", fileId: "f1" }],
            }),
      "/v1/reviews/load": () => success(canonicalJson),
    });
    const { result } = renderReading([]);
    act(() =>
      result.current.reading?.edit({
        reviewedGroupIds: [],
        expandedAppearances: [{ groupId: "g1", fileId: "f1" }],
        anchor: { kind: "top" },
      }),
    );
    await waitFor(() => expect(result.current.reading?.saveFailed).toBe(true));
    expect(result.current.reading?.progress.reviewedGroupIds).toEqual([]);
    expect(result.current.reading?.progress.expandedAppearances).toEqual([
      { groupId: "g1", fileId: "f1" },
    ]);
    expect(
      desktop.request.mock.calls.filter(
        ([request]) => "path" in request && request.path === path,
      ),
    ).toHaveLength(1);
    conflict = false;
    await act(async () => {
      expect(await result.current.reading?.retry()).toBe(true);
    });
    expect(desktop.request.mock.calls.at(-1)?.[0]).toMatchObject({
      path,
      body: { expectedStateVersion: 4, state: { reviewedGroupIds: [] } },
    });
  });

  it("keeps a conflicted save blocked while canonical reload fails, then retries with the established version", async () => {
    let conflict = true;
    let reloadFails = true;
    // SAFETY: workbench constructs a literal JSON fixture with omitted optional fields.
    const canonical = workbench({ ...initial, version: 4 }) as RawJsonValue;
    desktop = installDesktopDouble({
      [path]: () =>
        conflict
          ? failure({ error: "guide_version_conflict" }, 409)
          : success({ ...initial, version: 5, reviewedGroupIds: ["g1"] }),
      "/v1/reviews/load": () =>
        reloadFails
          ? failure({ error: "storage_unavailable" })
          : success(canonical),
    });
    const { result } = renderReading([]);
    act(() =>
      result.current.reading?.edit({
        reviewedGroupIds: ["g1"],
        expandedAppearances: [],
        anchor: { kind: "top" },
      }),
    );
    await waitFor(() => expect(result.current.reading?.saveFailed).toBe(true));
    conflict = false;
    await act(async () => {
      expect(await result.current.reading?.retry()).toBe(false);
    });
    expect(
      desktop.request.mock.calls.filter(
        ([request]) => "path" in request && request.path === path,
      ),
    ).toHaveLength(1);
    expect(result.current.reading?.progress.reviewedGroupIds).toEqual(["g1"]);
    reloadFails = false;
    await act(async () => {
      expect(await result.current.reading?.retry()).toBe(true);
    });
    expect(desktop.request.mock.calls.at(-1)?.[0]).toMatchObject({
      path,
      body: { expectedStateVersion: 4 },
    });
  });

  it("retries a preserved failed queue only when the desktop admission explicitly requests Retry", async () => {
    let fail = true;
    const double = installDesktopDouble({
      [path]: () =>
        fail
          ? failure({ error: "storage_unavailable" })
          : success({ ...initial, version: 1, reviewedGroupIds: ["g1"] }),
    });
    desktop = double;
    const { result } = renderReading([]);
    act(() =>
      result.current.reading?.edit({
        reviewedGroupIds: ["g1"],
        expandedAppearances: [],
        anchor: { kind: "top" },
      }),
    );
    await waitFor(() => expect(result.current.reading?.saveFailed).toBe(true));
    const approval = await double.guideAdmission({
      requestId: "inspect",
      phase: "inspect",
    });
    if (approval === undefined) throw new Error("No close inspection");
    const request = {
      requestId: "admit",
      phase: "admit" as const,
      approvedDraftRevision: approval.draftRevision,
      approvedRendererId: approval.rendererId,
    };
    expect((await double.guideAdmission(request))?.saved).toBe(false);
    fail = false;
    await act(async () => {
      expect(
        (await double.guideAdmission({ ...request, retryReading: true }))
          ?.saved,
      ).toBe(true);
    });
    expect(result.current.reading?.progress.version).toBe(1);
  });

  it("ignores a late old-result response after replacement resets reading state", async () => {
    let answer: ((response: DesktopResponse) => void) | undefined;
    desktop = installDesktopDouble({
      [path]: () =>
        new Promise<DesktopResponse>((resolve) => {
          answer = resolve;
        }),
    });
    const patches: ReviewWorkbenchPatch[] = [];
    const { result, rerender } = renderReading(patches);
    act(() =>
      result.current.reading?.edit({
        reviewedGroupIds: ["g1"],
        expandedAppearances: [],
        anchor: { kind: "top" },
      }),
    );
    await waitFor(() => expect(answer).toBeDefined());
    rerender(workbench({ ...initial, runId: replacedId }));
    await act(async () =>
      answer?.(success({ ...initial, version: 1, reviewedGroupIds: ["g1"] })),
    );
    expect(patches).toEqual([]);
    expect(result.current.reading?.progress.runId).toBe(replacedId);
    expect(result.current.reading?.progress.reviewedGroupIds).toEqual([]);
    expect(await result.current.owner.flush()).toBe(true);
  });

  it("adopts an externally replaced Guide before admitting navigation without transferring old progress", async () => {
    let answer: ((response: DesktopResponse) => void) | undefined;
    const replacement = workbench({ ...initial, runId: replacedId });
    desktop = installDesktopDouble({
      [path]: () =>
        new Promise<DesktopResponse>((resolve) => {
          answer = resolve;
        }),
      // SAFETY: workbench constructs a literal JSON fixture with omitted optional fields.
      "/v1/reviews/load": () => success(replacement as RawJsonValue),
    });
    const patches: ReviewWorkbenchPatch[] = [];
    const { result, rerender } = renderReading(patches);
    const oldReading = result.current.reading;
    act(() =>
      oldReading?.edit({
        reviewedGroupIds: ["g1"],
        expandedAppearances: [{ groupId: "g1", fileId: "f1" }],
        anchor: { kind: "file", groupId: "g1", fileId: "f1", offset: 35 },
      }),
    );
    await waitFor(() => expect(answer).toBeDefined());
    let entered = false;
    const entering = result.current.owner.navigate(() => {
      entered = true;
    });
    await act(async () =>
      answer?.(failure({ error: "guide_identity_conflict" }, 409)),
    );
    expect(await entering).toBe(true);
    expect(entered).toBe(true);
    expect(patches).toEqual([
      { insights: { guide: replacement.insights.guide } },
    ]);
    rerender(replacement);
    expect(result.current.reading?.progress).toMatchObject({
      runId: replacedId,
      version: 0,
      reviewedGroupIds: [],
      expandedAppearances: [],
      anchor: { kind: "top" },
    });
    act(() =>
      oldReading?.edit({
        reviewedGroupIds: ["g1"],
        expandedAppearances: [],
        anchor: { kind: "top" },
      }),
    );
    expect(await oldReading?.retry()).toBe(true);
    expect(
      desktop.request.mock.calls.filter(
        ([request]) => "path" in request && request.path === path,
      ),
    ).toHaveLength(1);
  });

  it("keeps progress and navigation held until a replacement reload can be validated on Retry", async () => {
    let reloadFails = true;
    const replacement = workbench({ ...initial, runId: replacedId });
    desktop = installDesktopDouble({
      [path]: () => failure({ error: "guide_identity_conflict" }, 409),
      "/v1/reviews/load": () =>
        reloadFails
          ? failure({ error: "storage_unavailable" })
          : // SAFETY: workbench constructs a literal JSON fixture with omitted optional fields.
            success(replacement as RawJsonValue),
    });
    const patches: ReviewWorkbenchPatch[] = [];
    const { result } = renderReading(patches);
    act(() =>
      result.current.reading?.edit({
        reviewedGroupIds: ["g1"],
        expandedAppearances: [],
        anchor: { kind: "top" },
      }),
    );
    await waitFor(() => expect(result.current.reading?.saveFailed).toBe(true));
    expect(await result.current.owner.flush()).toBe(false);
    expect(result.current.reading?.progress.reviewedGroupIds).toEqual(["g1"]);
    expect(patches).toEqual([]);
    reloadFails = false;
    await act(async () => {
      expect(await result.current.reading?.retry()).toBe(true);
    });
    expect(patches).toEqual([
      { insights: { guide: replacement.insights.guide } },
    ]);
    expect(await result.current.owner.flush()).toBe(true);
  });
});
