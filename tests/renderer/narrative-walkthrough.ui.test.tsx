// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@pierre/diffs/react", () => ({
  PatchDiff: ({ patch }: { patch: string }) => <div data-pierre-mock="true" data-patch={patch} />,
  FileDiff: ({ renderGutterUtility, lineAnnotations, renderAnnotation }: { readonly renderGutterUtility?: (getHoveredLine: () => unknown) => React.ReactNode; readonly lineAnnotations?: ReadonlyArray<{ readonly side: "additions" | "deletions"; readonly lineNumber: number; readonly metadata: unknown }>; readonly renderAnnotation?: (annotation: { readonly side: "additions" | "deletions"; readonly lineNumber: number; readonly metadata: unknown }) => React.ReactNode }) => <div>{renderGutterUtility?.(() => ({ lineNumber: 42, side: "additions" }))}{lineAnnotations?.map((annotation, index) => <div key={index}>{renderAnnotation?.(annotation)}</div>)}</div>,
}));

import { NarrativeWalkthrough, type NarrativeWalkthroughActions } from "../../src/renderer/src/components/narrative-walkthrough";
import type { NarrativeWalkthrough as NarrativeWalkthroughModel, NarrativeSnapshot } from "../../src/domain/narrative-walkthrough";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SNAPSHOT: NarrativeSnapshot = {
  profileId: "cfw" as never,
  sessionId: "github.com__centraldigital__patchdesk__pr-42__sha-22222222__abcdef123456" as never,
  headSha: "2222222222222222222222222222222222222222" as never,
  patchHash: "0000000000000000000000000000000000000000" as never,
};

function buildWalkthrough(): NarrativeWalkthroughModel {
  return {
    snapshot: SNAPSHOT,
    title: "Read-only walkthrough",
    focus: "What this change means for reviewers",
    chapters: [
      {
        id: "chapter-1",
        title: "Context",
        sections: [
          {
            id: "section-1",
            title: "Why this snapshot matters",
            prose: "The stored patch changes how the recovery path picks its next action.",
            hunkIds: ["h1"],
            hunks: [
              {
                id: "h1",
                path: "src/recovery/projection.ts" as never,
                header: "@@ -42 +42 @@",
                raw: "@@ -42 +42 @@\n-old\n+new",
                oldStart: 42,
                oldLines: 1,
                newStart: 42,
                newLines: 1,
              },
            ],
          },
        ],
      },
      {
        id: "chapter-2",
        title: "Behavior",
        sections: [
          {
            id: "section-2",
            title: "How reads stay read-only",
            prose: "Patchdesk only reads from the local cached review patch.",
            hunkIds: ["h2"],
            hunks: [
              {
                id: "h2",
                path: "src/services/review-workbench-projection.ts" as never,
                header: "@@ -18 +18 @@",
                raw: "@@ -18 +18 @@\n-old\n+new",
                oldStart: 18,
                oldLines: 1,
                newStart: 18,
                newLines: 1,
              },
            ],
          },
        ],
      },
    ],
    support: {
      id: "support",
      title: "Support",
      hunkIds: ["h3", "h4"],
      hunks: [
        {
          id: "h3",
          path: "src/services/recovery/storage-management-service.ts" as never,
          header: "@@ -1 +1 @@",
          raw: "@@ -1 +1 @@\n-old\n+new",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
        },
        {
          id: "h4",
          path: "tests/browser/review-workbench.spec.ts" as never,
          header: "@@ -1 +1 @@",
          raw: "@@ -1 +1 @@\n-old\n+new",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
        },
      ],
    },
  };
}

function buildActions(overrides: Partial<NarrativeWalkthroughActions> = {}): NarrativeWalkthroughActions {
  return {
    onBackToFiles: vi.fn(),
    onMarkSectionReviewed: vi.fn(),
    onMarkSupportReviewed: vi.fn(),
    onSelectSection: vi.fn(),
    ...overrides,
  };
}

describe("narrative walkthrough takeover", () => {
  it("does not steal focus when the takeover first mounts", () => {
    const opener = document.createElement("button");
    opener.type = "button";
    opener.textContent = "Existing opener";
    document.body.append(opener);
    opener.focus();
    render(<StrictMode><NarrativeWalkthrough walkthrough={buildWalkthrough()} reviewedSectionIds={[]} supportReviewed={false} actions={buildActions()} /></StrictMode>);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("renders the chapter rail, current section prose, and Support group", () => {
    const actions = buildActions();
    render(
      <NarrativeWalkthrough
        walkthrough={buildWalkthrough()}
        reviewedSectionIds={[]}
        supportReviewed={false}
        actions={actions}
      />,
    );
    expect(screen.getByRole("region", { name: "Walkthrough chapters" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Why this snapshot matters" })).toBeTruthy();
    expect(screen.getByText("The stored patch changes how the recovery path picks its next action.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark section reviewed" })).toBeTruthy();
    expect(screen.getByText("Support")).toBeTruthy();
  });

  it("shows the back to files control and never mutates Files state", () => {
    const onBackToFiles = vi.fn();
    const actions = buildActions({ onBackToFiles });
    render(
      <NarrativeWalkthrough
        walkthrough={buildWalkthrough()}
        reviewedSectionIds={[]}
        supportReviewed={false}
        actions={actions}
      />,
    );
    const back = screen.getByRole("button", { name: "Back to files" });
    fireEvent.click(back);
    expect(onBackToFiles).toHaveBeenCalledTimes(1);
  });

  it("moves between sections with Next and Previous controls", () => {
    const onSelectSection = vi.fn();
    const actions = buildActions({ onSelectSection });
    render(
      <NarrativeWalkthrough
        walkthrough={buildWalkthrough()}
        reviewedSectionIds={[]}
        supportReviewed={false}
        actions={actions}
      />,
    );
    const next = screen.getByRole("button", { name: "Next section" });
    fireEvent.click(next);
    expect(onSelectSection).toHaveBeenCalledWith("section-2");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "How reads stay read-only" }));
  });

  it("disables Previous at the first section and Next at the last section", () => {
    const actions = buildActions();
    const walkthrough = buildWalkthrough();
    render(
      <NarrativeWalkthrough
        walkthrough={walkthrough}
        reviewedSectionIds={[]}
        supportReviewed={false}
        actions={actions}
        currentSectionId="section-1"
      />,
    );
    expect((screen.getByRole("button", { name: "Previous section" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next section" }));
    expect(screen.getByRole("heading", { name: "How reads stay read-only" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next section" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Previous section" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("dispatches Mark section reviewed and Mark Support reviewed", () => {
    const onMarkSectionReviewed = vi.fn();
    const onMarkSupportReviewed = vi.fn();
    const actions = buildActions({ onMarkSectionReviewed, onMarkSupportReviewed });
    render(
      <NarrativeWalkthrough
        walkthrough={buildWalkthrough()}
        reviewedSectionIds={[]}
        supportReviewed={false}
        actions={actions}
      />,
    );
    expect(document.querySelector('[data-disclosure-motion="panel"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mark section reviewed" }));
    expect(onMarkSectionReviewed).toHaveBeenCalledWith("section-1");
    const supportToggle = screen.getByRole("button", { name: "Support" });
    expect(supportToggle.querySelector('[data-disclosure-motion="chevron"]')?.tagName).toBe("svg");
    fireEvent.click(supportToggle);
    expect(document.querySelector('[data-disclosure-motion="panel"]')).not.toBeNull();
    expect(document.querySelector('[data-disclosure-motion="chevron"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mark Support reviewed" }));
    expect(onMarkSupportReviewed).toHaveBeenCalledTimes(1);
  });

  it("opens the local composer on a changed walkthrough line", async () => {
    Object.defineProperty(CSSStyleSheet.prototype, "replaceSync", { configurable: true, value: () => undefined });
    const onSave = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <NarrativeWalkthrough
        walkthrough={buildWalkthrough()}
        reviewedSectionIds={[]}
        supportReviewed={false}
        localCommentAuthoring={{ enabled: true, onSave }}
        actions={buildActions()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add local comment on src/recovery/projection.ts" }));
    await user.type(screen.getByLabelText("Local comment"), "Use a safe path.");
    await user.click(screen.getByRole("button", { name: "Save local comment" }));
    expect(onSave).toHaveBeenCalledWith({
      path: "src/recovery/projection.ts",
      startLine: 42,
      line: 42,
      side: "new",
      body: "Use a safe path.",
      fingerprint: {
        path: "src/recovery/projection.ts",
        startLine: 42,
        line: 42,
        side: "new",
        selectedLines: ["new"],
        before: [],
        after: [],
      },
    });
  });

  it("preserves reviewed indicators and disables the toggle when already reviewed", () => {
    const onMarkSectionReviewed = vi.fn();
    const actions = buildActions({ onMarkSectionReviewed });
    render(
      <NarrativeWalkthrough
        walkthrough={buildWalkthrough()}
        reviewedSectionIds={["section-1"]}
        supportReviewed={false}
        actions={actions}
      />,
    );
    const reviewedChips = screen.getAllByLabelText("Reviewed");
    expect(reviewedChips.length).toBeGreaterThan(0);
    const markButton = screen.getByRole("button", { name: "Section reviewed" });
    expect((markButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(markButton);
    expect(onMarkSectionReviewed).not.toHaveBeenCalled();
  });

  it("renders unique block identifiers so repeated files do not collapse", () => {
    const base = buildWalkthrough();
    const firstChapter = base.chapters[0];
    const secondChapter = base.chapters[1];
    if (firstChapter === undefined || secondChapter === undefined || secondChapter.sections[0] === undefined) {
      throw new Error("Walkthrough fixture requires two chapters");
    }
    const next = secondChapter.sections[0];
    const walkthrough: NarrativeWalkthroughModel = {
      ...base,
      chapters: [
        firstChapter,
        {
          ...secondChapter,
          sections: [
            next,
            {
              id: "section-2b",
              title: "How the second section repeats the same file",
              prose: "It reuses the same file in another section.",
              hunkIds: ["h2b"],
              hunks: [
                {
                  id: "h2b",
                  path: "src/services/review-workbench-projection.ts" as never,
                  header: "@@ -22 +22 @@",
                  raw: "@@ -22 +22 @@\n-old\n+new",
                  oldStart: 22,
                  oldLines: 1,
                  newStart: 22,
                  newLines: 1,
                },
              ],
            },
          ],
        },
      ],
    };
    const actions = buildActions();
    render(
      <NarrativeWalkthrough
        walkthrough={walkthrough}
        reviewedSectionIds={[]}
        supportReviewed={false}
        actions={actions}
      />,
    );
    const diffs = document.querySelectorAll('[data-walkthrough-diff-block]');
    const ids = Array.from(diffs).map((node) => node.getAttribute('data-walkthrough-diff-block') ?? '');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("renders the active section diff through the focused Pierre block", () => {
    const actions = buildActions();
    render(
      <NarrativeWalkthrough
        walkthrough={buildWalkthrough()}
        reviewedSectionIds={[]}
        supportReviewed={false}
        actions={actions}
      />,
    );
    const diffs = document.querySelectorAll('[data-walkthrough-diff-block]');
    expect(diffs.length).toBeGreaterThan(0);
    const section = screen.getByRole("region", { name: "Walkthrough reading surface" });
    const firstDiff = diffs.item(0);
    expect(firstDiff).not.toBeNull();
    if (firstDiff !== null) expect(section.contains(firstDiff)).toBe(true);
  });

  it("supports j/k vim aliases only when no editor control has focus", async () => {
    const onSelectSection = vi.fn();
    const actions = buildActions({ onSelectSection });
    const { container } = render(
      <NarrativeWalkthrough
        walkthrough={buildWalkthrough()}
        reviewedSectionIds={[]}
        supportReviewed={false}
        actions={actions}
      />,
    );
    const takeover = container.querySelector('[data-walkthrough-takeover]') as HTMLElement;
    takeover.focus();
    await userEvent.keyboard("{k}");
    expect(onSelectSection).toHaveBeenCalledWith("section-2");
  });

  it("does not move sections when an input inside the walkthrough is focused", async () => {
    const onSelectSection = vi.fn();
    const actions = buildActions({ onSelectSection });
    Object.defineProperty(CSSStyleSheet.prototype, "replaceSync", { configurable: true, value: () => undefined });
    render(
      <NarrativeWalkthrough
        walkthrough={buildWalkthrough()}
        reviewedSectionIds={[]}
        supportReviewed={false}
        localCommentAuthoring={{ enabled: true, onSave: vi.fn().mockResolvedValue(undefined) }}
        actions={actions}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add local comment on src/recovery/projection.ts" }));
    const bodyInput = screen.getByLabelText("Local comment");
    bodyInput.focus();
    // With the input focused, the k keypress fires on the input and bubbles up to the takeover.
    // The handler must early-return for INPUT/SELECT/TEXTAREA targets so the section does not advance.
    await userEvent.keyboard("{k}");
    expect(onSelectSection).not.toHaveBeenCalled();
  });

  it("returns focus to the back to files button on Escape without closing", () => {
    const onBackToFiles = vi.fn();
    const actions = buildActions({ onBackToFiles });
    render(
      <NarrativeWalkthrough
        walkthrough={buildWalkthrough()}
        reviewedSectionIds={[]}
        supportReviewed={false}
        actions={actions}
      />,
    );
    const body = document.body;
    body.focus();
    fireEvent.keyDown(body, { key: "Escape" });
    expect(onBackToFiles).not.toHaveBeenCalled();
  });
});
