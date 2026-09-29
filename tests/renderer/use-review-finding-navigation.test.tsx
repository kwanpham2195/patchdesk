// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeViewScrollTarget } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";

import type { ReviewInlineAnnotation } from "../../src/renderer/src/components/review-diff-view";
import {
  FindingStepSlotContext,
  type FindingStepSlot,
} from "../../src/renderer/src/review-commands";
import type { ReviewDiffNavigationStatus } from "../../src/renderer/src/review-diff-keyboard-nav";
import { useReviewFindingNavigation } from "../../src/renderer/src/hooks/use-review-finding-navigation";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function annotation(
  lineNumber: number,
  metadata: Partial<ReviewInlineAnnotation> & { readonly id: string },
) {
  return {
    lineNumber,
    side: "additions" as const,
    metadata: {
      path: "",
      start: lineNumber,
      end: lineNumber,
      side: "new" as const,
      severity: "P1",
      title: metadata.id,
      explanation: "",
      ...metadata,
    },
  };
}

/** Two files in document order: `b.ts` first, its Findings listed out of line order, with a local comment card between them. */
function diffItems() {
  const items = [
    {
      id: "src/b.ts",
      annotations: [
        annotation(40, { id: "finding-b40", analysisFinding: true }),
        annotation(12, { id: "local-comment", localComment: { body: "x" } }),
        annotation(8, { id: "finding-b8", analysisFinding: true }),
      ],
    },
    {
      id: "src/a.ts",
      annotations: [annotation(3, { id: "finding-a3", analysisFinding: true })],
    },
  ];
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the hook reads only each item's id and annotations; the rest of Pierre's item shape plays no part in Finding order.
  return items as unknown as Parameters<
    typeof useReviewFindingNavigation
  >[0]["items"];
}

function fakeViewer(scrolls: Array<CodeViewScrollTarget>) {
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- CodeViewHandle has nine methods and this hook reaches two; a full structural stub would say nothing extra.
  const handle = {
    scrollTo: (target: CodeViewScrollTarget) => scrolls.push(target),
    getInstance: () => ({ getItem: (id: string) => ({ id }) }),
  } as unknown as CodeViewHandle<ReviewInlineAnnotation | undefined>;
  return { current: handle };
}

function addFindingCard(findingId: string): HTMLElement {
  const card = document.createElement("article");
  card.dataset.reviewInlineFinding = findingId;
  card.tabIndex = -1;
  document.body.append(card);
  return card;
}

function renderFindingNavigation(slot?: FindingStepSlot) {
  const scrolls: Array<CodeViewScrollTarget> = [];
  const statuses: Array<ReviewDiffNavigationStatus> = [];
  const wrapper = ({ children }: PropsWithChildren) => (
    <FindingStepSlotContext.Provider value={slot}>
      {children}
    </FindingStepSlotContext.Provider>
  );
  renderHook(
    () =>
      useReviewFindingNavigation({
        viewer: fakeViewer(scrolls),
        activePathRef: { current: undefined },
        items: diffItems(),
        fileMode: "all",
        onActiveFileChange: undefined,
        createNavigationOperation: () => ({
          report: (status) => statuses.push(status),
          isStale: () => false,
        }),
        virtualized: true,
        browserSupportsPierre: true,
        markdownPreviewActive: false,
      }),
    { wrapper },
  );
  return { scrolls, statuses };
}

function press(key: string, target: EventTarget = window): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

describe("useReviewFindingNavigation", () => {
  it("steps through Finding cards in file and line order, skips other cards, and stops at either end", async () => {
    const cards = ["finding-b8", "finding-b40", "finding-a3"].map(
      addFindingCard,
    );
    const { scrolls, statuses } = renderFindingNavigation();

    for (const [index, expected] of [
      { path: "src/b.ts", line: 8 },
      { path: "src/b.ts", line: 40 },
      { path: "src/a.ts", line: 3 },
    ].entries()) {
      press(")");
      await waitFor(() => expect(statuses).toHaveLength(index + 1));
      expect(scrolls.at(-1)).toMatchObject({
        type: "line",
        id: expected.path,
        lineNumber: expected.line,
      });
      expect(statuses.at(-1)).toMatchObject({
        kind: "finding",
        state: "target",
        position: index + 1,
        total: 3,
        path: expected.path,
        line: expected.line,
      });
      await waitFor(() => expect(document.activeElement).toBe(cards[index]));
    }

    press(")");
    expect(statuses.at(-1)).toMatchObject({
      kind: "finding",
      state: "last",
      total: 3,
    });
    expect(scrolls).toHaveLength(3);

    press("(");
    await waitFor(() => expect(statuses).toHaveLength(5));
    expect(statuses.at(-1)).toMatchObject({
      state: "target",
      path: "src/b.ts",
      line: 40,
    });
    press("(");
    await waitFor(() => expect(statuses).toHaveLength(6));
    press("(");
    expect(statuses.at(-1)).toMatchObject({ kind: "finding", state: "first" });
  });

  it("leaves ( and ) to a focused textarea", () => {
    const { scrolls, statuses } = renderFindingNavigation();
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    textarea.focus();
    const event = new KeyboardEvent("keydown", {
      key: ")",
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      textarea.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(statuses).toEqual([]);
    expect(scrolls).toEqual([]);
  });

  it("fills the Finding step slot so the ⌘K command steps like the key", async () => {
    const slot: FindingStepSlot = { current: undefined };
    const { scrolls, statuses } = renderFindingNavigation(slot);

    act(() => slot.current?.("next"));

    await waitFor(() => expect(statuses).toHaveLength(1));
    expect(scrolls.at(-1)).toMatchObject({ id: "src/b.ts", lineNumber: 8 });
    cleanup();
    expect(slot.current).toBeUndefined();
  });
});
