// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("previews verified Markdown independently and restores its normal diff", async () => {
    const styleSheet = Object.getOwnPropertyDescriptor(window, "CSSStyleSheet");
    if (
      window.CSSStyleSheet !== undefined &&
      window.CSSStyleSheet.prototype.replaceSync === undefined
    ) {
      window.CSSStyleSheet.prototype.replaceSync = () => undefined;
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
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);
    render(
      <DiffWorkbench
        patch={markdownPatch}
        sourceSession={{ profileId: "profile", sessionId: "session" }}
        localCommentAuthoring={{ enabled: true, onSave }}
      />,
    );

    const readmeModes = await screen.findByRole("group", {
      name: "Display mode for README.md",
    });
    expect(
      screen.getByRole("group", { name: "Display mode for docs/guide.md" }),
    ).toBeTruthy();
    await user.click(
      within(readmeModes).getByRole("button", { name: "Preview" }),
    );

    const preview = screen.getByRole("article", {
      name: "Preview of README.md",
    });
    expect(
      within(preview).getByRole("heading", { name: "Complete head" }),
    ).toBeTruthy();
    expect(within(preview).getByText("Tail paragraph")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Add comment on README.md" }),
    ).toBeNull();
    expect(
      screen.queryByRole("article", { name: "Preview of docs/guide.md" }),
    ).toBeNull();
    expect(
      within(
        screen.getByRole("group", {
          name: "Display mode for docs/guide.md",
        }),
      )
        .getByRole("button", { name: "Diff" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(readmeModes)
        .getByRole("button", { name: "Preview" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    await user.click(within(readmeModes).getByRole("button", { name: "Diff" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("article", { name: "Preview of README.md" }),
      ).toBeNull(),
    );
    expect(
      screen.getAllByRole("button", { name: "Add comment on README.md" })
        .length,
    ).toBeGreaterThan(0);
    if (styleSheet?.value !== undefined) {
      delete styleSheet.value.prototype.replaceSync;
    }
  });
});
