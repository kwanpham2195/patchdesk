// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useLocalDrafts } from "../../src/renderer/src/flows/use-local-drafts";
import type { LocalDraftEntry } from "../../src/renderer/src/local-draft-contracts";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import {
  failure,
  installDesktopDouble,
  success,
} from "./fake-desktop-response";
import {
  callBody,
  callPath,
  projection,
  withAnalysis,
} from "./review-workbench-fixtures";

const ADD = "/v1/reviews/local-drafts/add";
const REMOVE = "/v1/reviews/local-drafts/remove";
const NOTE_ADD = "/v1/reviews/local-drafts/notes/add";
let restore: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const drafted: LocalDraftEntry = {
  kind: "finding",
  findingId: "finding-1",
  analysisRunId: "insight-analysis-1-fixture",
  sessionId: "session-a",
  path: "src/a.ts",
  side: "new",
  startLine: 1,
  line: 1,
  title: "Missing boundary check",
  suggests: false,
};

/** A working-tree Review with a current Analysis and the given Local drafts. */
function localReview(
  localDrafts: ReadonlyArray<LocalDraftEntry>,
): WorkbenchResponse {
  const base = withAnalysis("actionable");
  // SAFETY: fixture data in the wire shape `parseWorkbenchResponse` accepts; the working-tree source replaces the pull request fields.
  return projection({
    ...base,
    session: {
      ...base.session,
      key: {
        ...base.session.key,
        source: { kind: "working_tree", branch: "main" },
      },
    },
    pullRequest: undefined,
    analysisReviewActions: undefined,
    localDrafts,
  } as never);
}

function renderDrafts(workbench: WorkbenchResponse) {
  const onWorkbenchPatch = vi.fn();
  const rendered = renderHook(() =>
    useLocalDrafts({ workbench, onWorkbenchPatch }),
  );
  return { ...rendered, onWorkbenchPatch };
}

describe("useLocalDrafts", () => {
  it("adds a Finding by identity and adopts the list the main process returns", async () => {
    const double = installDesktopDouble({
      [ADD]: () => success({ localDrafts: [drafted] }),
    });
    restore = double.restore;
    const { result, onWorkbenchPatch } = renderDrafts(localReview([]));

    await act(async () => result.current?.add("finding-1"));

    const call = double.request.mock.calls.find(
      ([input]) => callPath(input) === ADD,
    );
    expect(callBody(call?.[0])).toEqual({
      profileId: "profile",
      reviewId: "review-42",
      sessionId: "session-a",
      runId: "insight-analysis-1-fixture",
      findingId: "finding-1",
    });
    expect(onWorkbenchPatch).toHaveBeenCalledWith({ localDrafts: [drafted] });
  });

  it("removes a draft from an earlier Analysis run under that run's id", async () => {
    const earlier = {
      ...drafted,
      analysisRunId: "insight-analysis-0-earlier",
      sessionId: "session-0",
    };
    const double = installDesktopDouble({
      [REMOVE]: () => success({ localDrafts: [] }),
    });
    restore = double.restore;
    const { result, onWorkbenchPatch } = renderDrafts(localReview([earlier]));

    expect(result.current?.draftedFindingIds.has("finding-1")).toBe(false);
    await act(async () => result.current?.remove(earlier));

    const call = double.request.mock.calls.find(
      ([input]) => callPath(input) === REMOVE,
    );
    expect(callBody(call?.[0])).toMatchObject({
      runId: "insight-analysis-0-earlier",
      findingId: "finding-1",
    });
    expect(onWorkbenchPatch).toHaveBeenCalledWith({ localDrafts: [] });
  });

  it("keeps the list and says why when the main process refuses", async () => {
    restore = installDesktopDouble({
      [ADD]: () => failure({ error: "in_progress" }, 409),
    }).restore;
    const { result, onWorkbenchPatch } = renderDrafts(localReview([]));

    await act(async () => result.current?.add("finding-1"));

    expect(result.current?.error).toBeDefined();
    expect(onWorkbenchPatch).not.toHaveBeenCalled();
  });

  it("adds a note by its lines and text, and a refused note rejects with the reason and keeps the list", async () => {
    const note: LocalDraftEntry = {
      kind: "note",
      noteId: "note-1",
      sessionId: "session-a",
      path: "src/a.ts",
      side: "new",
      startLine: 1,
      line: 2,
      text: "Guard the empty case.",
    };
    const answers = [
      success({ localDrafts: [note] }),
      failure({ error: "not_applicable" }, 409),
    ];
    const double = installDesktopDouble({
      [NOTE_ADD]: () => answers.shift() ?? failure({ error: "storage" }, 503),
    });
    restore = double.restore;
    const { result, onWorkbenchPatch } = renderDrafts(localReview([]));
    const location = { path: "src/a.ts", side: "new" as const, line: 2 };

    await act(async () =>
      result.current?.notes?.add(
        { ...location, startLine: 1 },
        "Guard the empty case.",
      ),
    );
    let refusal: unknown;
    await act(async () => {
      await result.current?.notes
        ?.add({ ...location, startLine: 40, line: 40 }, "Too far.")
        .catch((cause: unknown) => {
          refusal = cause;
        });
    });

    expect(callBody(double.request.mock.calls[0]?.[0])).toEqual({
      profileId: "profile",
      reviewId: "review-42",
      sessionId: "session-a",
      path: "src/a.ts",
      side: "new",
      startLine: 1,
      line: 2,
      text: "Guard the empty case.",
    });
    expect(onWorkbenchPatch).toHaveBeenCalledTimes(1);
    expect(onWorkbenchPatch).toHaveBeenCalledWith({ localDrafts: [note] });
    expect(refusal).toBeInstanceOf(Error);
  });

  it("offers nothing on a pull request Review", () => {
    restore = installDesktopDouble({}).restore;

    expect(
      renderDrafts(withAnalysis("actionable")).result.current,
    ).toBeUndefined();
  });
});
