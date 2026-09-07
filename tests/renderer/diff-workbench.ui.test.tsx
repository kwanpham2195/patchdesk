// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent, {
  PointerEventsCheckLevel,
} from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DiffWorkbench } from "../../src/renderer/src/components/diff-workbench";
import type { LocalApiDesktopRequest } from "../../src/main/ipc-contract";
import {
  installDesktopDouble,
  success,
  type DesktopDouble,
} from "./fake-desktop-response";

const patch =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-old\n+new\n";
let desktop: DesktopDouble | undefined;

afterEach(() => {
  cleanup();
  desktop?.restore();
  desktop = undefined;
});

function requestedPath(input: LocalApiDesktopRequest): string {
  const body = input.body;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows the fake desktop boundary request; production parsing occurs in the local API route.
  if (body === null || typeof body !== "object" || !("path" in body)) return "";
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- narrows the one primitive this route-aware test double reflects in its response.
  return typeof body.path === "string" ? body.path : "";
}

const markdownPatch = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-# Before",
  "+# Complete head",
  "diff --git a/docs/guide.md b/docs/guide.md",
  "--- a/docs/guide.md",
  "+++ b/docs/guide.md",
  "@@ -1 +1 @@",
  "-Before",
  "+Guide head",
  "",
].join("\n");

/**
 * Pierre's CodeView renders only where constructable stylesheets exist, which
 * jsdom lacks. Returns the restore for the one own property this adds.
 */
function stubPierreStyleSheet(): () => void {
  if (window.CSSStyleSheet.prototype.replaceSync !== undefined)
    return () => undefined;
  window.CSSStyleSheet.prototype.replaceSync = () => undefined;
  return () => {
    // oxlint-disable-next-line no-dynamic-delete -- removes the exact own property stubbed above.
    delete (window.CSSStyleSheet.prototype as { replaceSync?: unknown })
      .replaceSync;
  };
}

type MarkdownWorkbench = {
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly container: HTMLElement;
  /** Moves the workbench's controlled selection, as the navigator would. */
  readonly rerender: (selectedPath: string) => void;
};

/**
 * Renders the workbench over two verified Markdown files with Pierre's
 * shadow-root stylesheet requirement stubbed in, and restores that stub after
 * the body runs.
 */
async function withMarkdownWorkbench(
  body: (workbench: MarkdownWorkbench) => Promise<void>,
): Promise<void> {
  const restoreStyleSheet = stubPierreStyleSheet();
  desktop = installDesktopDouble({
    "/v1/reviews/diff-file": (input) => {
      const path = requestedPath(input);
      const readme = path === "README.md";
      return success({
        state: "ready",
        oldFile: {
          name: path,
          contents: readme ? "# Before\n\nTail paragraph\n" : "Before\n",
        },
        newFile: {
          name: path,
          contents: readme
            ? "# Complete head\n\nTail paragraph\n"
            : "Guide head\n",
        },
      });
    },
  });
  // Pierre's CodeView suspends pointer events for 120 ms after any layout
  // pass as a scroll-jank guard, not as a UX state, and that suspension can
  // re-engage between any wait and the click it guards.
  const user = userEvent.setup({
    pointerEventsCheck: PointerEventsCheckLevel.Never,
  });
  const workbenchFor = (selectedPath: string): React.JSX.Element => (
    <DiffWorkbench
      patch={markdownPatch}
      controlledSelectedPath={selectedPath}
      sourceSession={{ profileId: "profile", sessionId: "session" }}
      localCommentAuthoring={{ enabled: true, onSave: vi.fn(async () => {}) }}
    />
  );
  const view = render(workbenchFor("README.md"));
  try {
    await body({
      user,
      container: view.container,
      rerender: (selectedPath) => view.rerender(workbenchFor(selectedPath)),
    });
  } finally {
    restoreStyleSheet();
  }
}

describe("diff workbench", () => {
  it("uses the Pierre navigator and opens a mapped finding without filter controls", () => {
    render(
      <DiffWorkbench
        patch={patch}
        finding={{ file: "src/b.ts", lineStart: 1, diffSide: "new" }}
      />,
    );
    expect(screen.queryByLabelText("Search changed files")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Findings" })).toBeNull();
    expect(screen.getByText("src/b.ts", { selector: "p" })).toBeTruthy();
  });

  it("keeps normal PR context out of the standalone diff surface", () => {
    render(<DiffWorkbench patch={patch} />);

    // The rail is absent by label, which is the same fact the grid template
    // used to be asserted for: a reserved 18rem column with nothing in it is
    // not a behaviour the maintainer can observe.
    expect(screen.queryByLabelText("Review context")).toBeNull();
    expect(screen.getByLabelText("Diff workbench")).toBeTruthy();
  });

  it("keeps Markdown in diff mode while verified head content is unavailable", async () => {
    desktop = installDesktopDouble({
      "/v1/reviews/diff-file": () =>
        success({ state: "unavailable", reason: "too_large" }),
    });
    render(
      <DiffWorkbench
        patch={[
          "diff --git a/README.md b/README.md",
          "--- a/README.md",
          "+++ b/README.md",
          "@@ -1 +1 @@",
          "-Before",
          "+After",
          "",
        ].join("\n")}
        sourceSession={{ profileId: "profile", sessionId: "session" }}
      />,
    );

    expect(
      screen.queryByRole("group", { name: "Display mode for README.md" }),
    ).toBeNull();
    await waitFor(() => expect(desktop?.request).toHaveBeenCalled());
    expect(
      screen.queryByRole("group", { name: "Display mode for README.md" }),
    ).toBeNull();
  });

  it("swaps the selected file's diff for its preview pane and back", async () => {
    await withMarkdownWorkbench(async ({ user, container }) => {
      const modes = await screen.findByRole("group", {
        name: "Display mode for README.md",
      });
      // One switch, for the file the pane draws -- not one per file header.
      expect(
        screen.queryByRole("group", { name: "Display mode for docs/guide.md" }),
      ).toBeNull();
      await user.click(within(modes).getByRole("button", { name: "Preview" }));

      const preview = screen.getByRole("article", {
        name: "Preview of README.md",
      });
      expect(
        within(preview).getByRole("heading", { name: "Complete head" }),
      ).toBeTruthy();
      expect(within(preview).getByText("Tail paragraph")).toBeTruthy();
      expect(container.querySelector(".review-diff-viewport")).toBeNull();

      await user.click(
        within(
          screen.getByRole("group", { name: "Display mode for README.md" }),
        ).getByRole("button", { name: "Diff" }),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("article", { name: "Preview of README.md" }),
        ).toBeNull(),
      );
      expect(container.querySelector(".review-diff-viewport")).toBeTruthy();
      expect(
        screen.getAllByRole("button", { name: "Add comment on README.md" })
          .length,
      ).toBeGreaterThan(0);
    });
  });

  it("restores a file's preview when it is selected again", async () => {
    await withMarkdownWorkbench(async ({ user, rerender }) => {
      const modes = await screen.findByRole("group", {
        name: "Display mode for README.md",
      });
      await user.click(within(modes).getByRole("button", { name: "Preview" }));
      expect(
        screen.getByRole("article", { name: "Preview of README.md" }),
      ).toBeTruthy();

      rerender("docs/guide.md");
      await waitFor(() =>
        expect(
          screen.queryByRole("article", { name: "Preview of README.md" }),
        ).toBeNull(),
      );
      expect(
        within(
          screen.getByRole("group", {
            name: "Display mode for docs/guide.md",
          }),
        )
          .getByRole("button", { name: "Diff" })
          .getAttribute("aria-pressed"),
      ).toBe("true");

      rerender("README.md");
      const restored = await screen.findByRole("article", {
        name: "Preview of README.md",
      });
      expect(within(restored).getByText("Tail paragraph")).toBeTruthy();
    });
  });

  it("previews a file that is already marked viewed", async () => {
    await withMarkdownWorkbench(async ({ user }) => {
      const modes = await screen.findByRole("group", {
        name: "Display mode for README.md",
      });
      await user.click(
        screen.getByRole("checkbox", { name: "Mark file README.md as viewed" }),
      );
      await user.click(within(modes).getByRole("button", { name: "Preview" }));

      expect(
        screen.getByRole("article", { name: "Preview of README.md" }),
      ).toBeTruthy();
    });
  });

  it("renders only the files a Scope filter leaves visible", () => {
    // File headers come from Pierre's CodeView, which needs the stub.
    const restoreStyleSheet = stubPierreStyleSheet();
    const scopedPatch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/docs/guide.md b/docs/guide.md",
      "--- a/docs/guide.md",
      "+++ b/docs/guide.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    render(
      <DiffWorkbench
        patch={scopedPatch}
        visiblePaths={new Set(["src/b.ts", "src/a.ts"])}
      />,
    );

    expect(
      screen
        .getAllByLabelText(/^Collapse file /)
        .map((header) => header.getAttribute("aria-label")),
    ).toEqual(["Collapse file src/a.ts", "Collapse file src/b.ts"]);
    restoreStyleSheet();
  });
});
