// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import {
  ReviewDiffView,
  type PendingReviewComposerActions,
} from "../../src/renderer/src/components/review-diff-view";
import { parseReviewDiff } from "../../src/renderer/src/review-diff-data";
import { DEFAULT_REVIEW_VIEW_PREFERENCES } from "../../src/renderer/src/review-view-preferences";
import { PatchdeskApiError } from "../../src/renderer/src/api-client";
import { parseGitHubThreadId } from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";
import type * as PierreDiffs from "@pierre/diffs";

const must = <T,>(result: Result<T, unknown>): T => {
  if (result._tag === "ok") return result.value;
  throw new Error("fixture");
};

// oxlint-disable-next-line anti-slop/no-module-mocking -- @pierre/diffs is a third-party rendering library with no DI seam patchdesk owns; `preloadHighlighter` loads a WASM-backed syntax highlighter that jsdom cannot run, so it is the one method stubbed here while every other export passes through real.
vi.mock("@pierre/diffs", async (importOriginal) => {
  const actual = await importOriginal<typeof PierreDiffs>();
  return {
    ...actual,
    preloadHighlighter: vi.fn(async () => undefined),
  };
});

afterEach(() => cleanup());

describe("review diff hydration", () => {
  it("does not hydrate a filtered non-virtualized walkthrough diff", () => {
    const request = vi.fn(async () => ({
      ok: true as const,
      status: 200 as const,
      body: {
        state: "ready",
        oldFile: { name: "src/a.ts", contents: "before\nold tail\n" },
        newFile: {
          name: "src/a.ts",
          contents: "after\nnew tail\nnew tail 2\n",
        },
      },
      correlationId: "test",
    }));
    Object.defineProperty(window, "patchdesk", {
      configurable: true,
      value: {
        request,
        openExternalHttps: async () => true,
        onNavigate: () => () => undefined,
        qaScrollDiagnosticsEnabled: false,
      },
    });
    const patch =
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-before\n+after\n";
    const parsed = parseReviewDiff(patch);

    render(
      <ReviewDiffView
        patch={patch}
        parsedFiles={parsed.files}
        fileStatsByPath={parsed.statsByPath}
        selectedPath="src/a.ts"
        preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
        collapsedPaths={new Set()}
        onPreferencesChange={() => undefined}
        onCollapsedPathsChange={() => undefined}
        sourceSession={{ profileId: "cfw", sessionId: "session" }}
        virtualized={false}
      />,
    );

    expect(request).not.toHaveBeenCalled();
  });

  it("submits a fingerprinted inline comment through the accessible fallback", async () => {
    const styleSheet = Object.getOwnPropertyDescriptor(window, "CSSStyleSheet");
    Object.defineProperty(window, "CSSStyleSheet", {
      configurable: true,
      value: undefined,
    });
    const onSave = vi.fn(async () => undefined);
    const patch =
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const parsed = parseReviewDiff(patch);
    const user = userEvent.setup();
    try {
      render(
        <ReviewDiffView
          patch={patch}
          parsedFiles={parsed.files}
          fileStatsByPath={parsed.statsByPath}
          selectedPath="src/a.ts"
          preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
          collapsedPaths={new Set()}
          onPreferencesChange={() => undefined}
          onCollapsedPathsChange={() => undefined}
          localCommentAuthoring={{ enabled: true, onSave }}
          virtualized={false}
        />,
      );
      const addition = document.querySelector<HTMLElement>(
        '[data-line-type="change-addition"]',
      );
      const commentButton = addition?.querySelector<HTMLButtonElement>(
        'button[aria-label="Add comment on src/a.ts"]',
      );
      if (commentButton === null || commentButton === undefined)
        throw new Error("Expected an inline comment action");
      expect(commentButton.getAttribute("title")).toBe(
        "Add comment on src/a.ts line 1",
      );
      await user.click(commentButton);
      await user.type(
        screen.getByRole("textbox", { name: "Inline comment" }),
        "Publish this",
      );
      await user.click(screen.getByRole("button", { name: "Comment" }));
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "src/a.ts",
          startLine: 1,
          line: 1,
          side: "new",
          fingerprint: expect.objectContaining({
            path: "src/a.ts",
            startLine: 1,
            line: 1,
            side: "new",
          }),
        }),
      );
    } finally {
      if (styleSheet === undefined)
        Reflect.deleteProperty(window, "CSSStyleSheet");
      else Object.defineProperty(window, "CSSStyleSheet", styleSheet);
    }
  });

  it("keeps a saved local comment rendered on its anchored line", async () => {
    const styleSheet = Object.getOwnPropertyDescriptor(window, "CSSStyleSheet");
    if (
      styleSheet?.value !== undefined &&
      styleSheet.value.prototype.replaceSync === undefined
    ) {
      styleSheet.value.prototype.replaceSync = () => undefined;
    }
    if (
      window.CSSStyleSheet !== undefined &&
      window.CSSStyleSheet.prototype.replaceSync === undefined
    ) {
      window.CSSStyleSheet.prototype.replaceSync = () => undefined;
    }
    const patch =
      "diff --git a/src/a.ts b/src/a.ts\\n--- a/src/a.ts\\n+++ b/src/a.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n";
    const parsed = parseReviewDiff(patch);
    try {
      render(
        <ReviewDiffView
          patch={patch}
          parsedFiles={parsed.files}
          fileStatsByPath={parsed.statsByPath}
          selectedPath="src/a.ts"
          preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
          collapsedPaths={new Set()}
          onPreferencesChange={() => undefined}
          onCollapsedPathsChange={() => undefined}
          annotations={[
            {
              id: "local-draft:comment-1",
              path: "src/a.ts",
              start: 1,
              end: 1,
              side: "new",
              severity: "info",
              title: "Local comment",
              explanation: "Keep this local",
              localComment: { body: "Keep this local" },
            },
          ]}
          virtualized={false}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByRole("article", {
            name: "Saved local comment on src/a.ts:1",
          }),
        ).toBeTruthy(),
      );
      expect(screen.getByText("Keep this local")).toBeTruthy();
      expect(screen.getByText("Mock reviewer")).toBeTruthy();
      expect(
        screen.getByText("Thanks — threaded replies are UI-only for now."),
      ).toBeTruthy();
      // SAFETY: every "Add reply…"/"Resolve"/"Delete" control in this tree is
      // the shadcn/ui `Button`, which always renders a native `<button>`, so
      // `getByRole("button", ...)` resolving here is an `HTMLButtonElement`.
      expect(
        (
          screen.getByRole("button", {
            name: "Add reply…",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      // SAFETY: see above — the "Resolve" control is the same shadcn/ui `Button`.
      expect(
        (screen.getByRole("button", { name: "Resolve" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      // SAFETY: see above — the "Delete" control is the same shadcn/ui `Button`.
      expect(
        (screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    } finally {
      if (styleSheet?.value !== undefined) {
        delete styleSheet.value.prototype.replaceSync;
      }
    }
  });

  it("shows a pending card immediately while the create is in flight, then reconciles to published", async () => {
    const styleSheet = Object.getOwnPropertyDescriptor(window, "CSSStyleSheet");
    if (
      styleSheet?.value !== undefined &&
      styleSheet.value.prototype.replaceSync === undefined
    ) {
      styleSheet.value.prototype.replaceSync = () => undefined;
    }
    if (
      window.CSSStyleSheet !== undefined &&
      window.CSSStyleSheet.prototype.replaceSync === undefined
    ) {
      window.CSSStyleSheet.prototype.replaceSync = () => undefined;
    }
    let resolveSave!: (value: { readonly commentId: string } | void) => void;
    const onSave = vi.fn(
      async () =>
        new Promise<{ readonly commentId: string } | void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const patch =
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const parsed = parseReviewDiff(patch);
    const user = userEvent.setup();
    try {
      render(
        <ReviewDiffView
          patch={patch}
          parsedFiles={parsed.files}
          fileStatsByPath={parsed.statsByPath}
          selectedPath="src/a.ts"
          preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
          collapsedPaths={new Set()}
          onPreferencesChange={() => undefined}
          onCollapsedPathsChange={() => undefined}
          localCommentAuthoring={{ enabled: true, onSave }}
          conversationActions={{ editComment: vi.fn(), deleteComment: vi.fn() }}
          virtualized={false}
        />,
      );
      const authorButtons = screen.getAllByRole("button", {
        name: "Add comment on src/a.ts",
      });
      const commentButton = authorButtons.at(-1);
      if (commentButton === undefined)
        throw new Error("Expected an inline comment action");
      // Pierre populates the gutter action's line from its internal hover
      // state, which jsdom cannot produce; seed it directly.
      commentButton.dataset.lineNumber = "1";
      commentButton.dataset.lineSide = "additions";
      await user.click(commentButton);
      await user.type(
        screen.getByRole("textbox", { name: "Inline comment" }),
        "Publish this",
      );
      await user.click(screen.getByRole("button", { name: "Comment" }));
      // The pending card is visible before the write completes.
      expect(
        screen.getByRole("article", { name: "Publishing conversation" }),
      ).toBeTruthy();
      expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
      resolveSave({ commentId: "PRRC_real" });
      await waitFor(() =>
        expect(
          screen.queryByRole("article", { name: "Publishing conversation" }),
        ).toBeNull(),
      );
      // The published card has the real comment id: Edit and Delete are
      // reachable, but Reply and Resolve are not, because the REST create
      // receipt carries no thread id.
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
      expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    } finally {
      if (styleSheet?.value !== undefined) {
        delete styleSheet.value.prototype.replaceSync;
      }
    }
  });

  it("shows a failed create card with dismiss and no GitHub controls when the write is rejected", async () => {
    const styleSheet = Object.getOwnPropertyDescriptor(window, "CSSStyleSheet");
    if (
      styleSheet?.value !== undefined &&
      styleSheet.value.prototype.replaceSync === undefined
    ) {
      styleSheet.value.prototype.replaceSync = () => undefined;
    }
    if (
      window.CSSStyleSheet !== undefined &&
      window.CSSStyleSheet.prototype.replaceSync === undefined
    ) {
      window.CSSStyleSheet.prototype.replaceSync = () => undefined;
    }
    const onSave = vi.fn(async () => {
      throw new Error("timeout");
    });
    const patch =
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const parsed = parseReviewDiff(patch);
    const user = userEvent.setup();
    try {
      render(
        <ReviewDiffView
          patch={patch}
          parsedFiles={parsed.files}
          fileStatsByPath={parsed.statsByPath}
          selectedPath="src/a.ts"
          preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
          collapsedPaths={new Set()}
          onPreferencesChange={() => undefined}
          onCollapsedPathsChange={() => undefined}
          localCommentAuthoring={{ enabled: true, onSave }}
          virtualized={false}
        />,
      );
      const authorButtons = screen.getAllByRole("button", {
        name: "Add comment on src/a.ts",
      });
      const commentButton = authorButtons.at(-1);
      if (commentButton === undefined)
        throw new Error("Expected an inline comment action");
      // Pierre populates the gutter action's line from its internal hover
      // state, which jsdom cannot produce; seed it directly.
      commentButton.dataset.lineNumber = "1";
      commentButton.dataset.lineSide = "additions";
      await user.click(commentButton);
      await user.type(
        screen.getByRole("textbox", { name: "Inline comment" }),
        "Will fail",
      );
      await user.click(screen.getByRole("button", { name: "Comment" }));
      const failed = await screen.findByRole("article", {
        name: "Comment failed conversation",
      });
      expect(failed).toBeTruthy();
      expect(screen.getByRole("alert")).toBeTruthy();
      // A failed card has no GitHub identity and no write actions.
      expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
      expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
      await user.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(
        screen.queryByRole("article", { name: "Comment failed conversation" }),
      ).toBeNull();
    } finally {
      if (styleSheet?.value !== undefined) {
        delete styleSheet.value.prototype.replaceSync;
      }
    }
  });

  it("preloads walkthrough languages and active themes before the non-virtualized diff", async () => {
    const styleSheet = Object.getOwnPropertyDescriptor(window, "CSSStyleSheet");
    if (
      styleSheet?.value !== undefined &&
      styleSheet.value.prototype.replaceSync === undefined
    ) {
      styleSheet.value.prototype.replaceSync = () => undefined;
    }
    if (
      window.CSSStyleSheet !== undefined &&
      window.CSSStyleSheet.prototype.replaceSync === undefined
    ) {
      window.CSSStyleSheet.prototype.replaceSync = () => undefined;
    }
    try {
      const { preloadHighlighter } = await import("@pierre/diffs");
      const preload = vi.mocked(preloadHighlighter);
      // Earlier tests may have primed the shared module mock; only this test's calls count.
      preload.mockClear();
      const patch =
        "diff --git a/src/main.go b/src/main.go\n--- a/src/main.go\n+++ b/src/main.go\n@@ -1 +1,2 @@\n package main\n+func main() {}\n";
      const parsed = parseReviewDiff(patch);
      render(
        <ReviewDiffView
          patch={patch}
          parsedFiles={parsed.files}
          fileStatsByPath={parsed.statsByPath}
          selectedPath="src/main.go"
          preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
          collapsedPaths={new Set()}
          onPreferencesChange={() => undefined}
          onCollapsedPathsChange={() => undefined}
          virtualized={false}
        />,
      );
      await waitFor(() => expect(preload).toHaveBeenCalled());
      expect(preload.mock.calls[0]?.[0]).toEqual({
        langs: ["go"],
        themes: ["pierre-dark", "pierre-light"],
      });
    } finally {
      if (styleSheet?.value !== undefined) {
        delete styleSheet.value.prototype.replaceSync;
      }
    }
  });
});

it("keeps Reply and Resolve off a published create card even when all global conversation actions are present", async () => {
  const styleSheet = Object.getOwnPropertyDescriptor(window, "CSSStyleSheet");
  if (
    styleSheet?.value !== undefined &&
    styleSheet.value.prototype.replaceSync === undefined
  ) {
    styleSheet.value.prototype.replaceSync = () => undefined;
  }
  if (
    window.CSSStyleSheet !== undefined &&
    window.CSSStyleSheet.prototype.replaceSync === undefined
  ) {
    window.CSSStyleSheet.prototype.replaceSync = () => undefined;
  }
  let resolveSave!: (value: { readonly commentId: string } | void) => void;
  const onSave = vi.fn(
    async () =>
      new Promise<{ readonly commentId: string } | void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  const setThreadState = vi.fn(async () => undefined);
  const replyToThread = vi.fn(async () => undefined);
  const editComment = vi.fn(async () => undefined);
  const deleteComment = vi.fn(async () => undefined);
  const patch =
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const parsed = parseReviewDiff(patch);
  const user = userEvent.setup();
  try {
    render(
      <ReviewDiffView
        patch={patch}
        parsedFiles={parsed.files}
        fileStatsByPath={parsed.statsByPath}
        selectedPath="src/a.ts"
        preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
        collapsedPaths={new Set()}
        onPreferencesChange={() => undefined}
        onCollapsedPathsChange={() => undefined}
        localCommentAuthoring={{ enabled: true, onSave }}
        conversationActions={{
          setThreadState,
          replyToThread,
          editComment,
          deleteComment,
        }}
        virtualized={false}
      />,
    );
    const authorButtons = screen.getAllByRole("button", {
      name: "Add comment on src/a.ts",
    });
    const commentButton = authorButtons.at(-1);
    if (commentButton === undefined)
      throw new Error("Expected an inline comment action");
    commentButton.dataset.lineNumber = "1";
    commentButton.dataset.lineSide = "additions";
    await user.click(commentButton);
    await user.type(
      screen.getByRole("textbox", { name: "Inline comment" }),
      "Publish this",
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(
      screen.getByRole("article", { name: "Publishing conversation" }),
    ).toBeTruthy();
    resolveSave({ commentId: "PRRC_real" });
    await waitFor(() =>
      expect(
        screen.queryByRole("article", { name: "Publishing conversation" }),
      ).toBeNull(),
    );
    // Edit and Delete use the authoritative comment id.
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    // The global thread callbacks must not be re-attached to a card that has
    // no GitHub thread id: no Reply, no Resolve, and no command calls.
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unresolve" })).toBeNull();
    expect(replyToThread).not.toHaveBeenCalled();
    expect(setThreadState).not.toHaveBeenCalled();
  } finally {
    if (styleSheet?.value !== undefined) {
      delete styleSheet.value.prototype.replaceSync;
    }
  }
});
describe("pending-review composer lifecycle", () => {
  const patch =
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
  // The accessible fallback renders the composer synchronously; the Pierre
  // code-view path renders annotations asynchronously in jsdom.
  const withFallbackDom = async (run: () => Promise<void>): Promise<void> => {
    const styleSheet = Object.getOwnPropertyDescriptor(window, "CSSStyleSheet");
    Object.defineProperty(window, "CSSStyleSheet", {
      configurable: true,
      value: undefined,
    });
    try {
      await run();
    } finally {
      if (styleSheet === undefined)
        Reflect.deleteProperty(window, "CSSStyleSheet");
      else Object.defineProperty(window, "CSSStyleSheet", styleSheet);
    }
  };
  const renderDiff = (
    overrides: Partial<ComponentProps<typeof ReviewDiffView>> = {},
  ) => {
    const parsed = parseReviewDiff(patch);
    return render(
      <ReviewDiffView
        patch={patch}
        parsedFiles={parsed.files}
        fileStatsByPath={parsed.statsByPath}
        selectedPath="src/a.ts"
        preferences={DEFAULT_REVIEW_VIEW_PREFERENCES}
        collapsedPaths={new Set()}
        onPreferencesChange={() => undefined}
        onCollapsedPathsChange={() => undefined}
        localCommentAuthoring={{
          enabled: true,
          onSave: vi.fn(async () => undefined),
        }}
        virtualized={false}
        {...overrides}
      />,
    );
  };
  // The Pierre code-view path renders composer and annotation portals
  // asynchronously in jsdom; keep constructable stylesheets available.
  const withCodeViewDom = async (run: () => Promise<void>): Promise<void> => {
    const styleSheet = Object.getOwnPropertyDescriptor(window, "CSSStyleSheet");
    if (
      window.CSSStyleSheet !== undefined &&
      window.CSSStyleSheet.prototype.replaceSync === undefined
    ) {
      window.CSSStyleSheet.prototype.replaceSync = () => undefined;
    }
    try {
      await run();
    } finally {
      if (styleSheet?.value !== undefined) {
        delete styleSheet.value.prototype.replaceSync;
      }
    }
  };
  const openCodeViewComposer = async (
    user: ReturnType<typeof userEvent.setup>,
    body: string,
  ) => {
    const authorButtons = await screen.findAllByRole("button", {
      name: "Add comment on src/a.ts",
    });
    const commentButton = authorButtons.at(-1);
    if (commentButton === undefined)
      throw new Error("Expected an inline comment action");
    commentButton.dataset.lineNumber = "1";
    commentButton.dataset.lineSide = "additions";
    await user.click(commentButton);
    await user.type(
      await screen.findByRole("textbox", { name: "Inline comment" }),
      body,
    );
  };
  const composerActions = (
    overrides: Partial<PendingReviewComposerActions> = {},
  ): PendingReviewComposerActions => ({
    state: { state: "none" },
    busy: false,
    onStartReview: vi.fn(async () => undefined),
    onAddReviewComment: vi.fn(async () => undefined),
    ...overrides,
  });
  const openComposer = async (user: ReturnType<typeof userEvent.setup>) => {
    const row = document.querySelector<HTMLElement>(
      '[data-line-type="change-addition"]',
    );
    const addButton = row?.querySelector<HTMLButtonElement>(
      'button[aria-label="Add comment on src/a.ts"]',
    );
    if (!addButton) throw new Error("Expected inline comment action");
    await user.click(addButton);
    await user.type(
      screen.getByRole("textbox", { name: "Inline comment" }),
      "test",
    );
  };

  it("closes the composer immediately when Start a review is submitted", async () => {
    await withFallbackDom(async () => {
      const user = userEvent.setup();
      const actions = composerActions();
      renderDiff({ pendingReviewComposer: actions });
      await openComposer(user);
      await user.click(screen.getByRole("button", { name: "Start a review" }));
      await waitFor(() =>
        expect(actions.onStartReview).toHaveBeenCalledTimes(1),
      );
      expect(
        screen.queryByRole("textbox", { name: "Inline comment" }),
      ).toBeNull();
    });
  });

  it("shows a transient starting card while the command is unresolved and removes it on success", async () => {
    await withCodeViewDom(async () => {
      const user = userEvent.setup();
      let resolveStart!: () => void;
      const startPromise = new Promise<void>((resolve) => {
        resolveStart = resolve;
      });
      const actions = composerActions({
        onStartReview: vi.fn(async () => {
          await startPromise;
        }),
      });
      renderDiff({ pendingReviewComposer: actions });
      await openCodeViewComposer(user, "test");
      await user.click(screen.getByRole("button", { name: "Start a review" }));
      expect(await screen.findByText("Starting review…")).toBeTruthy();
      expect(
        screen.queryByRole("textbox", { name: "Inline comment" }),
      ).toBeNull();
      resolveStart();
      await waitFor(() =>
        expect(screen.queryByText("Starting review…")).toBeNull(),
      );
      expect(actions.onStartReview).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps a bounded failed card on a confirmed rejection and never claims a thread", async () => {
    await withCodeViewDom(async () => {
      const user = userEvent.setup();
      const actions = composerActions({
        onStartReview: vi.fn(async () => {
          throw new PatchdeskApiError(
            "github_rejected",
            409,
            false,
            "corr",
            "rejected",
          );
        }),
      });
      renderDiff({ pendingReviewComposer: actions });
      await openCodeViewComposer(user, "test");
      await user.click(screen.getByRole("button", { name: "Start a review" }));
      expect(
        await screen.findByText("GitHub rejected this comment."),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
      // No retry is offered and no thread identity is advertised.
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(document.querySelector("[data-review-pending-thread]")).toBeNull();
    });
  });

  it("leaves no card when the outcome is unknown (recovery owns reconciliation)", async () => {
    await withCodeViewDom(async () => {
      const user = userEvent.setup();
      const actions = composerActions({
        onStartReview: vi.fn(async () => {
          throw new PatchdeskApiError(
            "outcome_unknown",
            503,
            false,
            "corr",
            "unknown",
          );
        }),
      });
      renderDiff({ pendingReviewComposer: actions });
      await openCodeViewComposer(user, "test");
      await user.click(screen.getByRole("button", { name: "Start a review" }));
      await waitFor(() =>
        expect(actions.onStartReview).toHaveBeenCalledTimes(1),
      );
      await waitFor(() =>
        expect(
          document.querySelector("[data-review-pending-write]"),
        ).toBeNull(),
      );
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("renders an authoritative pending-review thread card without published-thread controls", async () => {
    const styleSheet = Object.getOwnPropertyDescriptor(window, "CSSStyleSheet");
    if (
      window.CSSStyleSheet !== undefined &&
      window.CSSStyleSheet.prototype.replaceSync === undefined
    ) {
      window.CSSStyleSheet.prototype.replaceSync = () => undefined;
    }
    const threadId = must(parseGitHubThreadId("PRRT_pending_test"));
    renderDiff({
      annotations: [
        {
          id: "pending-review:PRRT_pending_test",
          path: "src/a.ts",
          start: 1,
          end: 1,
          side: "new",
          severity: "conversation",
          title: "Pending review",
          explanation: "",
          pendingReviewThread: {
            threadId,
            body: "Needs a follow-up",
            nodeId: "PRR_kwDORJzsQM7e6QwJ",
          },
        },
      ],
    });
    const card = await screen.findByRole("article", {
      name: "Pending review comment",
    });
    expect(card.textContent).toContain("Pending review");
    expect(card.textContent).toContain("Needs a follow-up");
    // No Reply/Resolve/Unresolve/edit/delete controls on a pending card.
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unresolve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    if (styleSheet?.value !== undefined) {
      delete styleSheet.value.prototype.replaceSync;
    }
  });
});
