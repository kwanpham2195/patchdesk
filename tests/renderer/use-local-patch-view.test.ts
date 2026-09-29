// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { RawJsonValue } from "../../src/domain/json";
import type { LocalApiDesktopRequest } from "../../src/main/ipc-contract";
import { useLocalPatchView } from "../../src/renderer/src/flows/use-local-patch-view";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";
import { callBody, projection } from "./review-workbench-fixtures";

const combinedPatch =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const committedPatch = combinedPatch.replaceAll("src/a.ts", "src/b.ts");
const uncommittedPatch = combinedPatch.replaceAll("src/a.ts", "src/c.ts");
const patchView = { patchHash: "c".repeat(64), paths: [] };

function sharedReview(sessionId: string): WorkbenchResponse {
  const base = projection();
  return projection({
    session: {
      ...base.session,
      id: sessionId,
      key: {
        ...base.session.key,
        source: {
          kind: "local_branch",
          branch: "feature",
          baseRef: "refs/heads/main",
        },
      },
    },
    pullRequest: undefined,
    fullPatch: combinedPatch,
    viewedPaths: ["src/a.ts"],
    patchViews: {
      combined: patchView,
      committed: patchView,
      uncommitted: patchView,
    },
  });
}

type Held = {
  readonly input: LocalApiDesktopRequest;
  readonly answer: (body: RawJsonValue) => void;
};

let desktop: DesktopDouble | undefined;
afterEach(() => {
  desktop?.restore();
  desktop = undefined;
});

/** Holds every patch-view read until the test answers it. */
function holdPatchViewReads(): Held[] {
  const held: Held[] = [];
  desktop = installDesktopDouble({
    "/v1/reviews/local-patch-view": (input) =>
      new Promise((resolve) => {
        held.push({ input, answer: (body) => resolve(success(body)) });
      }),
  });
  return held;
}

function viewResponse(
  sessionId: string,
  view: "committed" | "uncommitted",
  patch: string,
): RawJsonValue {
  return { sessionId, view, patch, patchHash: "d".repeat(64), viewedPaths: [] };
}

describe("useLocalPatchView", () => {
  it("drops a Committed read that answers after a switch to Uncommitted", async () => {
    const held = holdPatchViewReads();
    const { result } = renderHook(() =>
      useLocalPatchView({ workbench: sharedReview("session-a") }),
    );
    expect(result.current?.shown).toMatchObject({
      view: "combined",
      patch: combinedPatch,
      viewedPaths: ["src/a.ts"],
    });

    act(() => result.current?.select("committed"));
    act(() => result.current?.select("uncommitted"));
    await waitFor(() => expect(held).toHaveLength(2));
    expect(held.map(({ input }) => callBody(input))).toEqual([
      {
        profileId: "profile",
        reviewId: "review-42",
        sessionId: "session-a",
        view: "committed",
      },
      {
        profileId: "profile",
        reviewId: "review-42",
        sessionId: "session-a",
        view: "uncommitted",
      },
    ]);
    await act(async () =>
      held[1]?.answer(
        viewResponse("session-a", "uncommitted", uncommittedPatch),
      ),
    );
    await waitFor(() => expect(result.current?.status).toBe("ready"));
    await act(async () =>
      held[0]?.answer(viewResponse("session-a", "committed", committedPatch)),
    );

    expect(result.current?.selected).toBe("uncommitted");
    expect(result.current?.shown).toMatchObject({
      view: "uncommitted",
      patch: uncommittedPatch,
    });
  });

  it("reads the selected view again for a new session and ignores the old session's answer", async () => {
    const held = holdPatchViewReads();
    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useLocalPatchView({ workbench: sharedReview(sessionId) }),
      { initialProps: { sessionId: "session-a" } },
    );

    act(() => result.current?.select("committed"));
    await waitFor(() => expect(held).toHaveLength(1));
    rerender({ sessionId: "session-b" });
    await waitFor(() => expect(held).toHaveLength(2));
    await act(async () =>
      held[0]?.answer(viewResponse("session-a", "committed", committedPatch)),
    );
    expect(result.current?.status).toBe("loading");

    await act(async () =>
      held[1]?.answer(viewResponse("session-b", "committed", combinedPatch)),
    );
    await waitFor(() => expect(result.current?.status).toBe("ready"));
    expect(callBody(held[1]?.input)).toMatchObject({
      sessionId: "session-b",
      view: "committed",
    });
    expect(result.current?.shown).toMatchObject({
      sessionId: "session-b",
      view: "committed",
      patch: combinedPatch,
    });
  });
});
