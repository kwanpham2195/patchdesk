// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import type { WalkthroughDiffAuthoring } from "#src/renderer/src/components/walkthrough-diff-authoring";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { buildGuideInventory, retainGuide } from "#src/domain/guide";
import { GuideReader } from "#src/renderer/src/components/guide-reader";
import { must } from "#tests/services/insight-run-fixture";

afterEach(cleanup);
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
  it("shares file marks between repeated appearances while keeping expansion independent", async () => {
    function SharedMarks(): React.JSX.Element {
      const [paths, setPaths] = useState<ReadonlySet<string>>(new Set());
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
      return <GuideReader guide={textGuide} diffAuthoring={authoring} />;
    }
    const user = userEvent.setup();
    render(<SharedMarks />);
    const first = within(
      screen.getByRole("list", { name: "First behavior files" }),
    );
    const second = within(
      screen.getByRole("list", { name: "Supporting behavior files" }),
    );
    await user.click(first.getByRole("button", { name: "Viewed src/main.ts" }));
    expect(
      first.getByRole("button", { name: "Viewed src/main.ts", pressed: true }),
    ).toBeDefined();
    expect(
      second.getByRole("button", { name: "Viewed src/main.ts", pressed: true }),
    ).toBeDefined();
    await user.click(first.getByRole("button", { name: "File src/main.ts" }));
    expect(
      second
        .getByRole("button", { name: "File src/main.ts" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    await user.click(
      second.getByRole("button", { name: "Viewed src/main.ts" }),
    );
    expect(
      first.getByRole("button", { name: "Viewed src/main.ts", pressed: false }),
    ).toBeDefined();
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
    expect(evidence.textContent).toContain("old mode 100644");
    expect(evidence.textContent).toContain("new mode 100755");
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
