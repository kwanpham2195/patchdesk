// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { changeScopeFromPatch } from "../../src/domain/change-scope";
import { definedProps } from "../../src/domain/defined-props";
import {
  briefCitationChipLabel,
  briefCitationChipTitle,
  briefCitationStatusLine,
  briefOwnershipTree,
} from "../../src/renderer/src/brief-contracts";
import { BriefReader } from "../../src/renderer/src/components/brief-reader";
import { briefInsight, briefValue } from "./review-workbench-fixtures";

const retained = () => {
  const projection = briefInsight();
  if (projection.retained === undefined)
    throw new Error("the Brief fixture retains a value");
  return projection.retained;
};

const retainedWithDrift = () => {
  const base = retained();
  return {
    ...base,
    value: {
      ...briefValue,
      descriptionDrift: {
        claimed: [
          {
            quote: "Replies also reconcile after the write.",
            note: "No reply path changes in the diff.",
            citations: briefValue.goal[0]?.citations.slice(0, 1) ?? [],
          },
        ],
        undescribed: [
          {
            text: "Three services now pass the session into the write gate.",
            citations: briefValue.goal[0]?.citations.slice(1, 2) ?? [],
          },
        ],
      },
    },
  };
};

const CONTRACT_PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

const CONTRACT = {
  path: "src/a.ts",
  header: "@@ -1 +1 @@",
  raw: CONTRACT_PATCH,
  caption: "the writer's new return type",
};

const retainedWithCitedHunk = () => {
  const base = retained();
  return {
    ...base,
    value: { ...briefValue, citedHunks: { h1: CONTRACT_PATCH } },
  };
};

const FLOW = {
  trees: [
    {
      kind: "call_tree" as const,
      title: "Insight run",
      nodes: [
        {
          label: "Start insight run",
          change: "unchanged" as const,
          citations: [],
          children: [
            {
              label: "read patch",
              change: "added" as const,
              citations: [
                {
                  alias: "h1",
                  kind: "hunk" as const,
                  label: "@@ -1 +1 @@",
                  path: "src/a.ts",
                },
              ],
              children: [],
            },
            {
              label: "prepare shared context",
              change: "removed" as const,
              citations: [
                {
                  alias: "h2",
                  kind: "hunk" as const,
                  label: "@@ -1 +1 @@",
                  path: "src/a.ts",
                },
              ],
              children: [],
            },
          ],
        },
      ],
    },
  ],
};

const retainedWithFlow = () => {
  const base = retained();
  return {
    ...base,
    value: {
      ...briefValue,
      flow: FLOW,
      citedHunks: { h1: CONTRACT_PATCH },
    },
  };
};

const retainedWithOwnership = (withContract: boolean) => {
  const base = retained();
  return {
    ...base,
    value: {
      ...briefValue,
      ownership: {
        files: [
          {
            path: "src/a.ts",
            status: "modified" as const,
            additions: 1,
            deletions: 1,
          },
          {
            path: "tests/a.test.ts",
            status: "added" as const,
            additions: 12,
            deletions: 0,
          },
        ],
        notes: [{ path: "src/a.ts", note: "owns the read-back" }],
        ...definedProps({ contract: withContract ? CONTRACT : undefined }),
      },
    },
  };
};

const REACH = {
  symbols: [
    {
      name: "updateThreadComment",
      outsideCallerFiles: 2,
      outsidePaths: ["src/main/local-api.ts"],
      insidePR: true,
    },
  ],
  surfaces: [
    { surface: "Public API" },
    { surface: "Network write path", path: "src/adapters/writer.ts" },
  ],
  untested: [{ path: "src/a.ts", reason: "no_test_in_pr" as const }],
  removedStillReferenced: [
    { name: "updateComment", paths: ["src/main/local-api.ts"] },
  ],
  method: "text_match" as const,
  hop: 1 as const,
};

const retainedWithReach = () => {
  const base = retained();
  return { ...base, value: { ...briefValue, reach: REACH } };
};

const retainedWithoutReach = () => {
  const base = retained();
  return {
    ...base,
    value: { ...briefValue, reachUnavailable: "timed_out" as const },
  };
};

const START_HERE = {
  lead: "Read the writer first; the services only consume its return type.",
  order: [
    { path: "src/a.ts", why: "owns the read-back" },
    { path: "src/b.ts" },
  ],
};

const retainedWithStartHere = () => {
  const base = retained();
  return { ...base, value: { ...briefValue, startHere: START_HERE } };
};

/** The Walkthrough link's props: required, and only one test is about them. */
const walkthroughLink = {
  walkthroughStatus: "not_generated" as const,
  onOpenWalkthrough: () => undefined,
};

afterEach(() => cleanup());

describe("BriefReader", () => {
  it("renders one retained Brief and regenerates on request", async () => {
    const onRegenerate = vi.fn();
    const user = userEvent.setup();
    render(
      <BriefReader
        {...walkthroughLink}
        retained={retained()}
        scope={changeScopeFromPatch(
          "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        )}
        onRegenerate={onRegenerate}
      />,
    );

    expect(screen.getByRole("region", { name: "Goal" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Assumptions" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Provenance" })).toBeTruthy();
    expect(screen.getByRole("img", { name: /^Scope:/ })).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Description vs diff" }),
    ).toBeNull();
    expect(screen.queryByRole("region", { name: "Shape" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("renders both drift regions when the Brief compared the description", () => {
    render(
      <BriefReader
        {...walkthroughLink}
        retained={retainedWithDrift()}
        onRegenerate={() => undefined}
      />,
    );

    expect(
      screen.getByRole("region", { name: "Description vs diff" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Claimed, not in the diff" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "In the diff, not described" }),
    ).toBeTruthy();
  });

  it("renders the Shape tree and its contract hunk", () => {
    render(
      <BriefReader
        {...walkthroughLink}
        retained={retainedWithOwnership(true)}
        onRegenerate={() => undefined}
      />,
    );

    expect(screen.getByRole("region", { name: "Shape" })).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Plain text diff" }),
    ).toBeTruthy();
  });

  it("renders the Shape tree without a contract hunk", () => {
    render(
      <BriefReader
        {...walkthroughLink}
        retained={retainedWithOwnership(false)}
        onRegenerate={() => undefined}
      />,
    );

    expect(screen.getByRole("region", { name: "Shape" })).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Plain text diff" }),
    ).toBeNull();
  });

  it("renders the four Reach rows and states how the counts were made", () => {
    render(
      <BriefReader
        {...walkthroughLink}
        retained={retainedWithReach()}
        onRegenerate={() => undefined}
      />,
    );

    expect(screen.getByRole("region", { name: "Reach" })).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Changed contracts" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Surfaces crossed" }),
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "Untested reach" })).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Removed, still referenced" }),
    ).toBeTruthy();
    expect(screen.getByText(/one hop out from the diff/)).toBeTruthy();
    expect(screen.getByText(/not a call graph/)).toBeTruthy();
  });

  it("omits the Reach block and says why when the search could not answer", () => {
    render(
      <BriefReader
        {...walkthroughLink}
        retained={retainedWithoutReach()}
        onRegenerate={() => undefined}
      />,
    );

    expect(screen.queryByRole("region", { name: "Reach" })).toBeNull();
    expect(screen.getByText(/Reach was not counted/)).toBeTruthy();
  });

  it("omits the Reach block silently on a Brief retained before it existed", () => {
    render(
      <BriefReader
        {...walkthroughLink}
        retained={retained()}
        onRegenerate={() => undefined}
      />,
    );

    expect(screen.queryByRole("region", { name: "Reach" })).toBeNull();
    expect(screen.queryByText(/Reach was not counted/)).toBeNull();
  });

  it("renders the Start here card with its reading order", () => {
    render(
      <BriefReader
        {...walkthroughLink}
        retained={retainedWithStartHere()}
        onRegenerate={() => undefined}
      />,
    );

    const card = screen.getByRole("region", { name: "Start here" });
    expect(
      [...card.querySelectorAll("li")].map((item) => item.textContent),
    ).toEqual(["src/a.ts — owns the read-back", "src/b.ts"]);
  });

  it("omits the Start here card on a Brief retained before it existed", () => {
    render(
      <BriefReader
        {...walkthroughLink}
        retained={retained()}
        onRegenerate={() => undefined}
      />,
    );

    expect(screen.queryByRole("region", { name: "Start here" })).toBeNull();
  });

  it("opens the walkthrough that already stands for this revision", async () => {
    const onOpenWalkthrough = vi.fn();
    const user = userEvent.setup();
    render(
      <BriefReader
        retained={retainedWithStartHere()}
        onRegenerate={() => undefined}
        walkthroughStatus="current"
        onOpenWalkthrough={onOpenWalkthrough}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open walkthrough" }));
    expect(onOpenWalkthrough).toHaveBeenCalledTimes(1);
  });

  it("offers to generate a walkthrough when none stands for this revision", async () => {
    const onOpenWalkthrough = vi.fn();
    const user = userEvent.setup();
    render(
      <BriefReader
        retained={retainedWithStartHere()}
        onRegenerate={() => undefined}
        walkthroughStatus="outdated"
        onOpenWalkthrough={onOpenWalkthrough}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Generate walkthrough" }),
    );
    expect(onOpenWalkthrough).toHaveBeenCalledTimes(1);
  });

  it("opens a hunk preview from a cited chip", async () => {
    const user = userEvent.setup();
    render(
      <BriefReader
        {...walkthroughLink}
        retained={retainedWithCitedHunk()}
        onRegenerate={() => undefined}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Show hunk a.ts · h1",
    });
    expect(trigger.textContent).toContain("a.ts · h1");
    expect(screen.queryByText("src/a.ts")).toBeNull();

    await user.click(trigger);

    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("-old")).toBeTruthy();
  });

  it("renders a plain chip when the hunk has no preview", () => {
    render(
      <BriefReader
        {...walkthroughLink}
        retained={retained()}
        onRegenerate={() => undefined}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Show hunk a.ts · h1" }),
    ).toBeNull();
    expect(screen.queryByText("src/a.ts")).toBeNull();
  });

  it("renders one Flow view per tree with a kind badge and title", () => {
    render(
      <BriefReader
        {...walkthroughLink}
        retained={retainedWithFlow()}
        onRegenerate={() => undefined}
      />,
    );

    const region = screen.getByRole("region", { name: "Flow" });
    expect(region.textContent).toContain("call tree");
    expect(region.textContent).toContain("Insight run");
    expect(
      within(region).getByRole("button", { name: "Show hunk a.ts · h1" }),
    ).toBeTruthy();

    // The tree is static (no expand/collapse, no roving focus), so it renders
    // as plain rows rather than the ARIA tree widget.
    expect(within(region).queryByRole("tree")).toBeNull();
    expect(within(region).queryByRole("treeitem")).toBeNull();
    expect(within(region).queryByRole("group")).toBeNull();
  });

  it("marks an added row with + and its chip, a removed row with −, and leaves an unchanged row bare", () => {
    render(
      <BriefReader
        {...walkthroughLink}
        retained={retainedWithFlow()}
        onRegenerate={() => undefined}
      />,
    );

    const region = screen.getByRole("region", { name: "Flow" });
    const addedRow = within(region).getByText("read patch").closest("div");
    const removedRow = within(region)
      .getByText("prepare shared context")
      .closest("div");
    const unchangedRow = within(region)
      .getByText("Start insight run", { exact: false })
      .closest("div");

    if (addedRow === null) throw new Error("Expected the added row's div");
    expect(addedRow.textContent).toContain("+");
    expect(
      within(addedRow).getByRole("button", { name: "Show hunk a.ts · h1" }),
    ).toBeTruthy();
    expect(removedRow?.textContent).toContain("−");
    expect(unchangedRow?.textContent).not.toContain("+");
    expect(unchangedRow?.textContent).not.toContain("−");
  });

  it("indents a child row further than its parent", () => {
    render(
      <BriefReader
        {...walkthroughLink}
        retained={retainedWithFlow()}
        onRegenerate={() => undefined}
      />,
    );

    const region = screen.getByRole("region", { name: "Flow" });
    const parentLabel = within(region).getByText("Start insight run", {
      exact: false,
    });
    const childLabel = within(region).getByText("read patch");

    expect(childLabel.style.paddingLeft).not.toBe(
      parentLabel.style.paddingLeft,
    );
    expect(childLabel.style.paddingLeft).toBe("1rem");
    expect(parentLabel.style.paddingLeft).toBe("0rem");
  });

  it("omits the Flow section when the Brief has no flow", () => {
    render(
      <BriefReader
        {...walkthroughLink}
        retained={retained()}
        onRegenerate={() => undefined}
      />,
    );

    expect(screen.queryByRole("region", { name: "Flow" })).toBeNull();
  });

  it("copies one view's rows as diff text headed by its kind and title", async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    render(
      <BriefReader
        {...walkthroughLink}
        retained={retainedWithFlow()}
        onRegenerate={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Copy as diff" }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toMatch(/^```diff\n {2}call tree · /);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("leaves the Flow copy label unchanged when the clipboard write fails", async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValue(new Error("denied"));
    render(
      <BriefReader
        {...walkthroughLink}
        retained={retainedWithFlow()}
        onRegenerate={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Copy as diff" }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy as diff" })).toBeTruthy();
  });

  it("disables regeneration when no run may start", () => {
    render(
      <BriefReader
        {...walkthroughLink}
        retained={retained()}
        onRegenerate={() => undefined}
        regenerateDisabled
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "Regenerate" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("briefOwnershipTree", () => {
  const files = (count: number, directory: string) =>
    Array.from({ length: count }, (_, index) => ({
      path: `${directory}file-${String(index).padStart(2, "0")}.ts`,
      status: "modified" as const,
      additions: 1,
      deletions: 0,
    }));

  it("groups the skeleton by directory and attaches each note to its file", () => {
    const tree = briefOwnershipTree({
      files: [...files(1, "src/"), ...files(1, "tests/")],
      notes: [{ path: "src/file-00.ts", note: "owns the read-back" }],
    });
    expect(tree.map((group) => group.directory)).toEqual(["src/", "tests/"]);
    expect(tree[0]?.files[0]?.name).toBe("file-00.ts");
    expect(tree[0]?.files[0]?.note).toBe("owns the read-back");
    expect(tree[1]?.files[0]?.note).toBeUndefined();
  });

  it("collapses a directory past twelve files to a counted remainder", () => {
    const tree = briefOwnershipTree({ files: files(15, "src/"), notes: [] });
    expect(tree[0]?.files).toHaveLength(12);
    expect(tree[0]?.hidden).toBe(3);
  });
});

describe("brief citation labels", () => {
  it("names each evidence kind by its shortest identifier", () => {
    const [description, hunk, commit] = briefValue.goal[0]?.citations ?? [];
    expect(description && briefCitationChipLabel(description)).toBe("desc ¶1");
    expect(hunk && briefCitationChipLabel(hunk)).toBe("a.ts · h1");
    expect(commit && briefCitationChipLabel(commit)).toBe("c6d5d41");
  });

  it("keeps the whole path a hunk chip shortened away in its title", () => {
    const [, hunk] = briefValue.goal[0]?.citations ?? [];
    expect(hunk && briefCitationChipTitle(hunk)).toBe(
      "hunk: src/a.ts @@ -1 +1 @@",
    );
  });

  it("counts resolved citations against assumptions", () => {
    expect(briefCitationStatusLine(briefValue)).toBe(
      "3 verified · 1 assumption",
    );
  });
});
