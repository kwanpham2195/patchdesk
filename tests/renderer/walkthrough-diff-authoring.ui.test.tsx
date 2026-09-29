// @vitest-environment jsdom
import "./pierre-highlighter-mock";
import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseGitHubThreadId,
  parseRepoRelativePath,
} from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";
import type { NarrativeHunk } from "../../src/domain/narrative-walkthrough";
import type { LocalNoteControls } from "../../src/renderer/src/flows/use-local-drafts";
import type { PendingReviewDrafts } from "../../src/renderer/src/hooks/use-pending-review-drafts";
import { NarrativeWalkthroughDiff } from "../../src/renderer/src/components/narrative-walkthrough-diff";
import { InsightsSlot } from "../../src/renderer/src/components/review-insights-slot";
import type { ReviewWorkbenchActions } from "../../src/renderer/src/components/review-workbench-contracts";
import {
  useWalkthroughDiffAuthoring,
  WalkthroughDiffAuthoringContext,
  type WalkthroughDiffAuthoring,
} from "../../src/renderer/src/components/walkthrough-diff-authoring";
import type { WorkbenchResponse } from "../../src/renderer/src/renderer-contracts";
import { DEFAULT_REVIEW_VIEW_PREFERENCES } from "../../src/renderer/src/review-view-preferences";
import { dragDiffGutter, hoveredGutterButton } from "./pierre-gutter";
import { projection, withWalkthrough } from "./review-workbench-fixtures";

const stubbedReplaceSync = CSSStyleSheet.prototype.replaceSync === undefined;
beforeEach(() => {
  if (stubbedReplaceSync) CSSStyleSheet.prototype.replaceSync = () => undefined;
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  if (stubbedReplaceSync)
    Reflect.deleteProperty(CSSStyleSheet.prototype, "replaceSync");
});

function parsed<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("Invalid fixture id");
  return result.value;
}

const lines = (from: number, to: number, prefix: string) =>
  Array.from(
    { length: to - from + 1 },
    (_, index) => `${prefix}line ${String(from + index)}`,
  );
// Hunk h1 changes lines 12-18 on both sides; hunk h2 changes line 41.
const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,10 +10,10 @@",
  " line 10",
  " line 11",
  ...lines(12, 18, "-old "),
  ...lines(12, 18, "+new "),
  " line 19",
  "@@ -40,3 +40,3 @@",
  " line 40",
  "-old line 41",
  "+new line 41",
  " line 42",
  "",
].join("\n");
const h1: NarrativeHunk = {
  id: "h1",
  path: parsed(parseRepoRelativePath("src/a.ts")),
  header: "@@ -10,10 +10,10 @@",
  raw: "",
  oldStart: 10,
  oldLines: 10,
  newStart: 10,
  newLines: 10,
};
const h2: NarrativeHunk = {
  ...h1,
  id: "h2",
  header: "@@ -40,3 +40,3 @@",
  oldStart: 40,
  oldLines: 3,
  newStart: 40,
  newLines: 3,
};

function authoring(
  overrides: Partial<WalkthroughDiffAuthoring> = {},
): WalkthroughDiffAuthoring {
  const drafts: PendingReviewDrafts = {
    writes: [],
    updateWrites: () => undefined,
    orphanedBody: undefined,
    setOrphanedBody: () => undefined,
    fullPatch: PATCH,
  };
  return {
    localCommentAuthoring: {
      enabled: true,
      kind: "note",
      onSave: async () => undefined,
    },
    pendingReviewDrafts: drafts,
    conversationActions: {},
    annotations: [],
    ...overrides,
  };
}

function renderBlock(
  hunks: ReadonlyArray<NarrativeHunk>,
  diffAuthoring: WalkthroughDiffAuthoring,
): void {
  render(
    <NarrativeWalkthroughDiff
      blockId="block"
      patch={PATCH}
      hunkIds={hunks.map((hunk) => hunk.id)}
      hunks={hunks}
      allHunks={[h1, h2]}
      // Split view keeps every row inside what Pierre renders in jsdom.
      preferences={{ ...DEFAULT_REVIEW_VIEW_PREFERENCES, diffStyle: "split" }}
      diffAuthoring={diffAuthoring}
    />,
  );
}

/**
 * A Walkthrough whose one section cites hunk h1. `withWalkthrough` retains it
 * for another session and head, so it is of an older revision unless the
 * Review is moved onto its snapshot.
 */
function walkthroughOf(revision: "current" | "older"): WorkbenchResponse {
  const base = withWalkthrough();
  const retained = base.insights.walkthrough.retained;
  if (retained === undefined) throw new Error("expected a Walkthrough");
  const { snapshot } = retained.value;
  const section = {
    id: "section-1",
    title: "Range section",
    prose: "Read the range.",
    hunkIds: ["h1"],
    hunks: [h1],
  };
  const current = revision === "current";
  return {
    ...base,
    session: current
      ? { ...base.session, id: snapshot.sessionId }
      : base.session,
    revision: current
      ? {
          ...base.revision,
          reviewedHeadSha: snapshot.headSha,
          patchHash: snapshot.patchHash,
        }
      : base.revision,
    fullPatch: PATCH,
    insights: {
      ...base.insights,
      walkthrough: {
        ...base.insights.walkthrough,
        retained: {
          ...retained,
          value: {
            ...retained.value,
            chapters: [
              { id: "chapter-1", title: "Chapter", sections: [section] },
            ],
          },
        },
      },
    },
  };
}

function renderInsights(
  workbench: WorkbenchResponse,
  diffAuthoring: WalkthroughDiffAuthoring,
): void {
  render(
    <WalkthroughDiffAuthoringContext.Provider value={diffAuthoring}>
      <InsightsSlot
        workbench={workbench}
        initialDetail="walkthrough"
        onWorkbenchReplace={() => undefined}
        onWorkbenchPatch={() => undefined}
        onReprepare={async () => workbench}
      />
    </WalkthroughDiffAuthoringContext.Provider>,
  );
}

describe("Walkthrough diff authoring", () => {
  it("opens a comment composer from the gutter button of a current Walkthrough", async () => {
    renderInsights(
      walkthroughOf("current"),
      authoring({
        localCommentAuthoring: { enabled: true, onSave: async () => undefined },
      }),
    );

    await dragDiffGutter({ line: 15 });

    expect(
      await screen.findByRole("textbox", { name: "Inline comment" }),
    ).toBeTruthy();
  });

  it("offers no gutter button on a Walkthrough of an older revision", async () => {
    renderInsights(walkthroughOf("older"), authoring());

    await waitFor(() => expect(hoveredGutterButton({ line: 15 })).toBeNull());
    expect(
      screen.getByText("Older revision; regenerate to see replies."),
    ).toBeTruthy();
  });

  it("opens one note composer for a gutter drag across lines 12 to 18 of a hunk", async () => {
    renderBlock([h1], authoring());

    await dragDiffGutter({ line: 12 }, { line: 18 });

    const [composer, ...others] = await screen.findAllByRole("region", {
      name: "Note composer",
    });
    expect(others).toEqual([]);
    if (composer === undefined) throw new Error("expected a composer");
    expect(within(composer).getByText(/Lines 12–18/)).toBeTruthy();
  });

  it("refuses a gutter drag that leaves the hunk", async () => {
    renderBlock([h1, h2], authoring());

    await dragDiffGutter({ line: 12 }, { line: 41 });

    expect(
      await screen.findByRole("status", { name: "Lines not selected" }),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Note composer" })).toBeNull();
  });

  it("shows a pending comment on its hunk only, and offers Reply on a published thread", async () => {
    const pending = (id: string, line: number) => ({
      id: `pending-review:${id}`,
      path: "src/a.ts",
      start: line,
      end: line,
      side: "new" as const,
      severity: "conversation",
      title: "Pending review",
      explanation: "",
      pendingReviewThread: {
        threadId: parsed(parseGitHubThreadId(id)),
        body: `Pending on ${String(line)}`,
        nodeId: "PRR_1",
      },
    });
    render(
      <NarrativeWalkthroughDiff
        blockId="block"
        patch={PATCH}
        hunkIds={["h1"]}
        hunks={[h1]}
        allHunks={[h1, h2]}
        preferences={{ ...DEFAULT_REVIEW_VIEW_PREFERENCES, diffStyle: "split" }}
        annotations={[
          {
            id: "PRRT_published",
            path: "src/a.ts",
            start: 12,
            end: 14,
            side: "new",
            state: "open",
            comments: [
              {
                id: "c1",
                author: "octocat",
                body: "Why three lines?",
                createdAt: "2026-09-01T00:00:00.000Z",
              },
            ],
          },
        ]}
        diffAuthoring={authoring({
          localCommentAuthoring: {
            enabled: true,
            onSave: async () => undefined,
          },
          conversationActions: { replyToThread: async () => undefined },
          annotations: [pending("PRRT_in", 16), pending("PRRT_out", 41)],
        })}
      />,
    );

    const pendingCards = await screen.findAllByRole("article", {
      name: "Pending review comment",
    });
    expect(pendingCards).toHaveLength(1);
    expect(
      within(pendingCards[0] as HTMLElement).getByText("Pending on 16"),
    ).toBeTruthy();
    const thread = screen.getByRole("article", {
      name: "open conversation thread",
    });
    expect(within(thread).getByRole("textbox", { name: "Reply" })).toBeTruthy();
  });

  it("saves a Walkthrough note in Combined whatever view the Diff tab shows", async () => {
    const add = vi.fn<LocalNoteControls["add"]>(async () => undefined);
    const diffTabSave = vi.fn(async () => undefined);
    const actions: ReviewWorkbenchActions = {
      detectUpdates: async () => undefined,
      refresh: async () => undefined,
      // SAFETY: building authoring never loads a diff.
      loadCommitDiff: async () => ({}) as never,
      // SAFETY: building authoring never loads a diff.
      loadSinceReviewDiff: async () => ({}) as never,
      reportNavigationState: () => undefined,
      localCommentAuthoring: {
        enabled: true,
        kind: "note",
        onSave: diffTabSave,
      },
      localNotes: {
        add,
        edit: async () => undefined,
        remove: async () => undefined,
      },
    };
    const { result } = renderHook(() =>
      useWalkthroughDiffAuthoring({
        model: projection({ fullPatch: PATCH }),
        actions,
        pendingReviewDrafts: authoring().pendingReviewDrafts,
        pendingReviewAnnotations: [],
      }),
    );

    await result.current.localCommentAuthoring?.onSave({
      path: "src/a.ts",
      startLine: 12,
      line: 18,
      side: "new",
      body: "Split this block.",
    });

    expect(add).toHaveBeenCalledWith(
      { path: "src/a.ts", startLine: 12, line: 18, side: "new" },
      "Split this block.",
      "combined",
    );
    expect(diffTabSave).not.toHaveBeenCalled();
  });
});
