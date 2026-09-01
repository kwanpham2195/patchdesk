import { describe, expect, it } from "vitest";

import type { BriefCitation } from "../../src/domain/brief";
import {
  normalizeBriefFlow,
  type BriefFlowOutput,
} from "../../src/domain/brief-flow";
import { parseRepoRelativePath } from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";

function value<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("test fixture failed");
  return result.value;
}

/** h1..h3 hunks, one description paragraph (d1), one commit (c1). */
const MANIFEST: ReadonlyArray<BriefCitation> = [
  {
    alias: "h1",
    kind: "hunk",
    label: "@@ -1,2 +1,3 @@ recovery",
    path: value(parseRepoRelativePath("src/recovery.ts")),
  },
  {
    alias: "h2",
    kind: "hunk",
    label: "@@ -10,2 +10,3 @@ retry",
    path: value(parseRepoRelativePath("src/retry.ts")),
  },
  {
    alias: "h3",
    kind: "hunk",
    label: "@@ -20,2 +20,3 @@ guard",
    path: value(parseRepoRelativePath("src/guard.ts")),
  },
  {
    alias: "d1",
    kind: "description",
    label: "Recovery could not restart after a crash.",
  },
  { alias: "c1", kind: "commit", label: "1234567 fix: guard recovery" },
];
const BY_ALIAS = new Map(MANIFEST.map((entry) => [entry.alias, entry]));

function normalize(raw: BriefFlowOutput) {
  return normalizeBriefFlow(raw, BY_ALIAS);
}

describe("normalizeBriefFlow", () => {
  it("keeps a fully cited mock-up tree intact, rejecting nothing", () => {
    const raw: BriefFlowOutput = [
      {
        title: "Brief",
        nodes: [
          {
            label: "Start insight run",
            change: "unchanged",
            children: [
              {
                label: "prepare shared context",
                change: "removed",
                citations: ["h1"],
              },
              { label: "read patch", change: "added", citations: ["h1"] },
              {
                label: "build citation manifest",
                change: "added",
                citations: ["h3"],
              },
            ],
          },
          { label: "Ask model for structured JSON", change: "unchanged" },
          {
            label: "Validate citations and normalize output",
            change: "added",
            citations: ["h3"],
          },
          { label: "Persist snapshot-bound Brief", change: "unchanged" },
        ],
      },
    ];
    const result = normalize(raw);
    expect(result.rejected).toBe(0);
    expect(result.value?.trees).toHaveLength(1);
    const [tree] = result.value?.trees ?? [];
    expect(tree?.title).toBe("Brief");
    expect(tree?.nodes).toHaveLength(4);
    expect(tree?.nodes[0]?.children.map((node) => node.change)).toEqual([
      "removed",
      "added",
      "added",
    ]);
    expect(
      tree?.nodes[0]?.children.map((node) =>
        node.citations.map((citation) => citation.alias),
      ),
    ).toEqual([["h1"], ["h1"], ["h3"]]);
  });

  it("drops a changed node with no citation, and its child, counting 2 rejected", () => {
    const raw: BriefFlowOutput = [
      {
        title: "Warm the cache",
        nodes: [
          { label: "valid change", change: "added", citations: ["h1"] },
          {
            label: "invented step",
            change: "added",
            citations: [],
            children: [{ label: "invented child", change: "unchanged" }],
          },
        ],
      },
    ];
    const result = normalize(raw);
    expect(result.rejected).toBe(2);
    expect(result.value?.trees[0]?.nodes.map((node) => node.label)).toEqual([
      "valid change",
    ]);
  });

  it("drops a removed node that cites only the description", () => {
    const raw: BriefFlowOutput = [
      {
        title: "Right step, wrong evidence",
        nodes: [
          { label: "valid change", change: "added", citations: ["h1"] },
          {
            label: "retire the legacy check",
            change: "removed",
            citations: ["d1"],
          },
        ],
      },
    ];
    const result = normalize(raw);
    // 1 for the discarded d1 alias, 1 for the node dropped with no hunk left.
    expect(result.rejected).toBe(2);
    expect(result.value?.trees[0]?.nodes.map((node) => node.label)).toEqual([
      "valid change",
    ]);
  });

  it("keeps an unchanged node with a bogus citation, discarding the citation", () => {
    const raw: BriefFlowOutput = [
      {
        title: "Note the intent",
        nodes: [
          { label: "valid change", change: "added", citations: ["h1"] },
          { label: "note the intent", change: "unchanged", citations: ["d1"] },
        ],
      },
    ];
    const result = normalize(raw);
    expect(result.rejected).toBe(1);
    const kept = result.value?.trees[0]?.nodes.find(
      (node) => node.label === "note the intent",
    );
    expect(kept?.citations).toEqual([]);
  });

  it("keeps a changed node citing a hunk and a commit, discarding only the commit", () => {
    const raw: BriefFlowOutput = [
      {
        title: "Log the branch taken",
        nodes: [
          {
            label: "Log the branch taken",
            change: "added",
            citations: ["h1", "c1"],
          },
        ],
      },
    ];
    const result = normalize(raw);
    expect(result.rejected).toBe(1);
    expect(
      result.value?.trees[0]?.nodes[0]?.citations.map((c) => c.alias),
    ).toEqual(["h1"]);
  });

  it("drops a tree where every step is unchanged", () => {
    const raw: BriefFlowOutput = [
      {
        title: "Rename usernameField to displayName",
        nodes: [
          { label: "Read the form state", change: "unchanged" },
          { label: "Validate the field", change: "unchanged" },
          { label: "Save the profile", change: "unchanged" },
        ],
      },
    ];
    const result = normalize(raw);
    expect(result.value).toBeUndefined();
    expect(result.rejected).toBe(1);
  });

  it("keeps only the first two of three surviving trees, in input order", () => {
    const raw: BriefFlowOutput = [
      {
        title: "Tree A",
        nodes: [{ label: "change A", change: "added", citations: ["h1"] }],
      },
      {
        title: "Tree B",
        nodes: [{ label: "change B", change: "added", citations: ["h2"] }],
      },
      {
        title: "Tree C",
        nodes: [{ label: "change C", change: "added", citations: ["h3"] }],
      },
    ];
    const result = normalize(raw);
    expect(result.value?.trees.map((tree) => tree.title)).toEqual([
      "Tree A",
      "Tree B",
    ]);
    expect(result.rejected).toBe(1);
  });

  it("drops a node past the 3-level depth cap", () => {
    const raw: BriefFlowOutput = [
      {
        title: "Depth test",
        nodes: [
          {
            label: "L1",
            change: "unchanged",
            children: [
              {
                label: "L2",
                change: "unchanged",
                children: [
                  {
                    label: "L3",
                    change: "added",
                    citations: ["h1"],
                    children: [
                      { label: "L4", change: "added", citations: ["h2"] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const result = normalize(raw);
    expect(result.rejected).toBe(1);
    const l3 = result.value?.trees[0]?.nodes[0]?.children[0]?.children[0];
    expect(l3?.label).toBe("L3");
    expect(l3?.children).toEqual([]);
  });

  it("drops nodes past the 15-node-per-tree cap", () => {
    const nodes = Array.from({ length: 20 }, (_, index) => {
      const label = `Step ${String(index + 1)}`;
      if (index === 0)
        return { label, change: "added" as const, citations: ["h1"] };
      return { label, change: "unchanged" as const };
    });
    const raw: BriefFlowOutput = [{ title: "Too many steps", nodes }];
    const result = normalize(raw);
    expect(result.value?.trees[0]?.nodes).toHaveLength(15);
    expect(result.rejected).toBe(5);
  });

  it("drops a label longer than 80 characters", () => {
    const raw: BriefFlowOutput = [
      {
        title: "Long label",
        nodes: [
          { label: "keep this step", change: "added", citations: ["h1"] },
          { label: "x".repeat(90), change: "unchanged" },
        ],
      },
    ];
    const result = normalize(raw);
    expect(result.rejected).toBe(1);
    expect(result.value?.trees[0]?.nodes.map((node) => node.label)).toEqual([
      "keep this step",
    ]);
  });

  it("returns no value and rejects nothing when the model offers no flow", () => {
    const result = normalize(undefined);
    expect(result.value).toBeUndefined();
    expect(result.rejected).toBe(0);
  });
});
