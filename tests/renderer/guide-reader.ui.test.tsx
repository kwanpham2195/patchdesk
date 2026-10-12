// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import type { WalkthroughDiffAuthoring } from "#src/renderer/src/components/walkthrough-diff-authoring";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { buildGuideInventory, retainGuide } from "#src/domain/guide";
import { parseInsightRunId, parseReviewSessionId } from "#src/domain/ids";
import type { GuideReadingState } from "#src/domain/guide-reading-state";
import { GuideReader } from "#src/renderer/src/components/guide-reader";
import { must } from "#tests/services/insight-run-fixture";
import {
  loadReviewViewPreferences,
  saveReviewViewPreferences,
} from "#src/renderer/src/review-view-preferences";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
const patchText =
  "diff --git a/src/a.ts b/src/a.ts\nold mode 100644\nnew mode 100755\ndiff --git a/assets/icon.png b/assets/icon.png\nBinary files a/assets/icon.png and b/assets/icon.png differ\n";
const inventory = must(buildGuideInventory(patchText));
const group = {
  title: "Recovery",
  explanation:
    "Read **pending state**. <script>alert(1)</script> ![unsafe](https://example.com/image.png)",
  files: [{ fileId: "f1", relevance: "Restores the saved request." }],
};
describe("Guide overview", () => {
  it("shows each membership, repeated files and exact Others while keeping rich model content inert", () => {
    const guide = must(
      retainGuide(
        {
          groups: [
            group,
            { ...group, title: "Support", explanation: "Checks recovery." },
          ],
        },
        { patchText, inventory },
      ),
    );
    const { container } = render(<GuideReader guide={guide} />);
    expect(screen.getByRole("heading", { name: "Recovery" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Support" })).toBeDefined();
    expect(
      screen.getByRole("heading", { name: "Others · 1 file" }),
    ).toBeDefined();
    expect(
      within(screen.getByRole("list", { name: "Recovery files" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(1);
    expect(
      within(screen.getByRole("list", { name: "Support files" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(1);
    expect(
      within(screen.getByRole("list", { name: "Others files" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(1);
    expect(container.querySelector("script")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

const textPatch =
  "diff --git a/src/main.ts b/src/main.ts\nold mode 100644\nnew mode 100755\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-oldFirst()\n+snapshotFirst()\n@@ -20 +20 @@\n-oldSecond()\n+snapshotSecond()\n";
const textGuide = must(
  retainGuide(
    {
      groups: [
        {
          title: "First behavior",
          explanation: "Explains only the first change.",
          files: [{ fileId: "f1", relevance: "First change." }],
        },
        {
          title: "Supporting behavior",
          explanation: "Supporting use.",
          files: [{ fileId: "f1", relevance: "Shared file." }],
        },
      ],
    },
    { patchText: textPatch, inventory: must(buildGuideInventory(textPatch)) },
  ),
);

describe("Guide shared Viewed controls", () => {
  it("shows the shared marks in every appearance when the selected Diff view refuses mutation", () => {
    render(
      <GuideReader
        guide={textGuide}
        viewedPaths={new Set(["src/main.ts"])}
        disabledReason="The selected Diff view cannot change Combined Viewed marks."
      />,
    );
    const marks = screen.getAllByRole("checkbox", {
      name: "Viewed src/main.ts",
      checked: true,
    });
    expect(marks).toHaveLength(2);
    for (const mark of marks) expect(mark.hasAttribute("disabled")).toBe(true);
  });

  it("shares file Viewed marks while keeping group Reviewed and appearance expansion independent", async () => {
    function SharedMarks(): React.JSX.Element {
      const [paths, setPaths] = useState<ReadonlySet<string>>(new Set());
      const [progress, setProgress] = useState<GuideReadingState>({
        runId: must(
          parseInsightRunId(
            "insight-guide-1-aaaaaaaaaaaa-github.com__octo-org__patchdesk__pr-42__review-aaaaaaaaaaaa",
          ),
        ),
        sessionId: must(
          parseReviewSessionId(
            "github.com__octo-org__patchdesk__pr-42__sha-aaaaaaaa__base-00000000__b48f8e2e76ca",
          ),
        ),
        version: 0,
        reviewedGroupIds: [],
        expandedAppearances: [],
        anchor: { kind: "top" },
      });
      const authoring: WalkthroughDiffAuthoring = {
        pendingReviewDrafts: {
          writes: [],
          updateWrites: () => undefined,
          orphanedBody: undefined,
          setOrphanedBody: () => undefined,
          fullPatch: textPatch,
        },
        conversationActions: {},
        annotations: [],
        viewedFiles: { paths, setPaths, saveFailed: false },
      };
      return (
        <GuideReader
          guide={textGuide}
          diffAuthoring={authoring}
          reading={{
            progress,
            saveFailed: false,
            edit: (content) =>
              setProgress((current) => ({ ...current, ...content })),
            retry: async () => true,
          }}
        />
      );
    }
    const user = userEvent.setup();
    render(<SharedMarks />);
    const first = within(
      screen.getByRole("list", { name: "First behavior files" }),
    );
    const second = within(
      screen.getByRole("list", { name: "Supporting behavior files" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Reviewed First behavior" }),
    );
    expect(
      screen.getByRole("button", {
        name: "Reviewed First behavior",
        pressed: true,
      }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", {
        name: "Reviewed Supporting behavior",
        pressed: false,
      }),
    ).toBeDefined();
    expect(
      first.getByRole("checkbox", {
        name: "Viewed src/main.ts",
        checked: false,
      }),
    ).toBeDefined();
    await user.click(
      first.getByRole("checkbox", { name: "Viewed src/main.ts" }),
    );
    expect(
      first.getByRole("checkbox", {
        name: "Viewed src/main.ts",
        checked: true,
      }),
    ).toBeDefined();
    expect(
      second.getByRole("checkbox", {
        name: "Viewed src/main.ts",
        checked: true,
      }),
    ).toBeDefined();
    await user.click(first.getByRole("button", { name: "File src/main.ts" }));
    expect(
      second
        .getByRole("button", { name: "File src/main.ts" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    await user.click(
      second.getByRole("checkbox", { name: "Viewed src/main.ts" }),
    );
    expect(
      first.getByRole("checkbox", {
        name: "Viewed src/main.ts",
        checked: false,
      }),
    ).toBeDefined();
    expect(
      first
        .getByRole("button", { name: "File src/main.ts" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });
});

describe("Guide drawing preferences", () => {
  it("applies one local View menu to open and later-opened appearances without changing global preferences", async () => {
    saveReviewViewPreferences({ diffStyle: "split", overflow: "scroll" });
    const user = userEvent.setup();
    render(<GuideReader guide={textGuide} />);
    const first = within(
      screen.getByRole("list", { name: "First behavior files" }),
    );
    const second = within(
      screen.getByRole("list", { name: "Supporting behavior files" }),
    );
    await user.click(first.getByRole("button", { name: "File src/main.ts" }));
    expect(
      screen.getAllByRole("button", { name: "View options" }),
    ).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "View options" }));
    await user.click(await screen.findByRole("switch", { name: "Split view" }));
    await user.click(screen.getByRole("switch", { name: "Wrap lines" }));
    const fullContext = screen.getByRole("switch", {
      name: "Full context",
      checked: false,
    });
    expect(fullContext.getAttribute("aria-disabled")).toBe("true");
    await user.click(fullContext);
    expect(
      screen.getByRole("switch", { name: "Full context", checked: false }),
    ).toBeDefined();
    await user.keyboard("{Escape}");
    await user.click(second.getByRole("button", { name: "File src/main.ts" }));
    expect(
      first
        .getByRole("region", { name: /^Review diff/ })
        .getAttribute("data-diff-style"),
    ).toBe("unified");
    expect(
      second
        .getByRole("region", { name: /^Review diff/ })
        .getAttribute("data-diff-style"),
    ).toBe("unified");
    expect(
      screen.getAllByRole("button", { name: "View options" }),
    ).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "View options" }));
    expect(
      await screen.findByRole("switch", { name: "Wrap lines", checked: true }),
    ).toBeDefined();
    expect(loadReviewViewPreferences()).toMatchObject({
      diffStyle: "split",
      overflow: "scroll",
    });
  });
});

describe("Guide complete snapshot evidence", () => {
  it("starts collapsed and expands every hunk independently for repeated memberships", async () => {
    const user = userEvent.setup();
    render(<GuideReader guide={textGuide} />);
    const first = within(
      screen.getByRole("list", { name: "First behavior files" }),
    );
    const second = within(
      screen.getByRole("list", { name: "Supporting behavior files" }),
    );
    expect(
      first
        .getByRole("button", { name: "File src/main.ts" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen.queryByRole("group", { name: "Guide evidence src/main.ts" }),
    ).toBeNull();
    await user.click(first.getByRole("button", { name: "File src/main.ts" }));
    const evidence = first.getByRole("group", {
      name: "Guide evidence src/main.ts",
    });
    expect(evidence.querySelector("details")).toBeNull();
    expect(evidence.textContent).toContain("snapshotFirst()");
    expect(evidence.textContent).toContain("snapshotSecond()");
    expect(
      second.queryByRole("group", { name: "Guide evidence src/main.ts" }),
    ).toBeNull();
    await user.click(second.getByRole("button", { name: "File src/main.ts" }));
    await user.click(first.getByRole("button", { name: "File src/main.ts" }));
    expect(
      first.queryByRole("group", { name: "Guide evidence src/main.ts" }),
    ).toBeNull();
    expect(
      second.getByRole("group", { name: "Guide evidence src/main.ts" })
        .textContent,
    ).toContain("snapshotSecond()");
    expect(screen.queryByRole("button", { name: "Add comment" })).toBeNull();
  });

  it("expands Others and preserves stored metadata without inventing text evidence", async () => {
    const user = userEvent.setup();
    const guide = must(
      retainGuide({ groups: [group] }, { patchText, inventory }),
    );
    render(<GuideReader guide={guide} />);
    await user.click(screen.getByRole("button", { name: "File src/a.ts" }));
    expect(
      screen.getByRole("group", { name: "Guide evidence src/a.ts" })
        .textContent,
    ).toContain("new mode 100755");
    await user.click(
      screen.getByRole("button", { name: "File assets/icon.png" }),
    );
    expect(
      screen.getByRole("group", { name: "Guide evidence assets/icon.png" })
        .textContent,
    ).toContain("Binary files a/assets/icon.png and b/assets/icon.png differ");
  });
  it.each([
    {
      name: "rename",
      path: "src/new.ts",
      block:
        "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 100%\nrename from src/old.ts\nrename to src/new.ts\n",
      expected: "rename from src/old.ts",
    },
    {
      name: "omitted",
      path: "src/large.ts",
      block: "diff --git a/src/large.ts b/src/large.ts\ndiff too large\n",
      expected: "diff too large",
    },
    {
      name: "submodule",
      path: "vendor/module",
      block:
        "diff --git a/vendor/module b/vendor/module\nSubmodule vendor/module abc123..def456\n",
      expected: "Submodule vendor/module abc123..def456",
    },
  ])("shows retained $name evidence", async ({ path, block, expected }) => {
    const user = userEvent.setup();
    const guide = must(
      retainGuide(
        {
          groups: [
            {
              title: "Evidence",
              explanation: "Stored change.",
              files: [{ fileId: "f1", relevance: "Supports the change." }],
            },
          ],
        },
        { patchText: block, inventory: must(buildGuideInventory(block)) },
      ),
    );
    render(<GuideReader guide={guide} />);
    await user.click(screen.getByRole("button", { name: `File ${path}` }));
    expect(
      screen.getByRole("group", { name: `Guide evidence ${path}` }).textContent,
    ).toContain(expected);
  });
});
