import * as v from "valibot";
import { describe, expect, it } from "vitest";

import type { BriefCitation } from "../../src/domain/brief";
import {
  briefFlowOutputSchema,
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
        kind: "call_tree",
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
    expect(tree?.kind).toBe("call_tree");
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

  it("keeps an uncited added node and its child, counting 1 rejected", () => {
    const raw: BriefFlowOutput = [
      {
        kind: "call_tree",
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
    expect(result.rejected).toBe(1);
    expect(result.value?.trees[0]?.nodes.map((node) => node.label)).toEqual([
      "valid change",
      "invented step",
    ]);
    const kept = result.value?.trees[0]?.nodes.find(
      (node) => node.label === "invented step",
    );
    expect(kept?.citations).toEqual([]);
    expect(kept?.children.map((node) => node.label)).toEqual([
      "invented child",
    ]);
  });

  it("keeps a removed node that cites only the description, with 0 citations", () => {
    const raw: BriefFlowOutput = [
      {
        kind: "call_tree",
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
    // 1 for the discarded d1 alias, 1 for the node left with no hunk citation.
    expect(result.rejected).toBe(2);
    expect(result.value?.trees[0]?.nodes.map((node) => node.label)).toEqual([
      "valid change",
      "retire the legacy check",
    ]);
    const kept = result.value?.trees[0]?.nodes.find(
      (node) => node.label === "retire the legacy check",
    );
    expect(kept?.citations).toEqual([]);
  });

  it("keeps an unchanged node with a bogus citation, discarding the citation", () => {
    const raw: BriefFlowOutput = [
      {
        kind: "call_tree",
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
        kind: "call_tree",
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
        kind: "call_tree",
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
    expect(result.rejected).toBe(0);
  });

  it("keeps a tree whose only changed step is uncited, since it is not all-unchanged", () => {
    const raw: BriefFlowOutput = [
      {
        kind: "call_tree",
        title: "Uncited change only",
        nodes: [
          { label: "Read the form state", change: "unchanged" },
          { label: "Validate the field", change: "added", citations: [] },
          { label: "Save the profile", change: "unchanged" },
        ],
      },
    ];
    const result = normalize(raw);
    expect(result.rejected).toBe(1);
    expect(result.value?.trees[0]?.nodes.map((node) => node.label)).toEqual([
      "Read the form state",
      "Validate the field",
      "Save the profile",
    ]);
  });

  it("keeps three trees of three different kinds, in input order", () => {
    const raw: BriefFlowOutput = [
      {
        kind: "call_tree",
        title: "Tree A",
        nodes: [{ label: "change A", change: "added", citations: ["h1"] }],
      },
      {
        kind: "control_flow",
        title: "Tree B",
        nodes: [{ label: "change B", change: "added", citations: ["h2"] }],
      },
      {
        kind: "component",
        title: "Tree C",
        nodes: [{ label: "change C", change: "added", citations: ["h3"] }],
      },
    ];
    const result = normalize(raw);
    expect(result.value?.trees.map((tree) => tree.title)).toEqual([
      "Tree A",
      "Tree B",
      "Tree C",
    ]);
    expect(result.value?.trees.map((tree) => tree.kind)).toEqual([
      "call_tree",
      "control_flow",
      "component",
    ]);
    expect(result.rejected).toBe(0);
  });

  it("keeps only the first of two same-kind trees, dropping the second silently", () => {
    const raw: BriefFlowOutput = [
      {
        kind: "call_tree",
        title: "First call tree",
        nodes: [{ label: "keep(a, b)", change: "added", citations: ["h1"] }],
      },
      {
        kind: "call_tree",
        title: "Second call tree",
        nodes: [{ label: "keep(c, d)", change: "added", citations: ["h2"] }],
      },
    ];
    const result = normalize(raw);
    expect(result.value?.trees.map((tree) => tree.title)).toEqual([
      "First call tree",
    ]);
    expect(result.rejected).toBe(0);
  });

  it("keeps a child with the same label as its parent, so a real recursion stays visible", () => {
    const raw: BriefFlowOutput = [
      {
        kind: "call_tree",
        title: "Self nested",
        nodes: [
          {
            label: "refreshToken()",
            change: "unchanged",
            children: [
              { label: "refreshToken()", change: "added", citations: ["h1"] },
            ],
          },
        ],
      },
    ];
    const result = normalize(raw);
    expect(result.rejected).toBe(0);
    const nodes = result.value?.trees[0]?.nodes ?? [];
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.label).toBe("refreshToken()");
    expect(nodes[0]?.change).toBe("unchanged");
    expect(nodes[0]?.children).toHaveLength(1);
    expect(nodes[0]?.children[0]?.label).toBe("refreshToken()");
    expect(nodes[0]?.children[0]?.change).toBe("added");
    expect(
      nodes[0]?.children[0]?.citations.map((citation) => citation.alias),
    ).toEqual(["h1"]);
  });

  it("rejects a tree with no kind at the schema level, whole and unparsed", () => {
    const noKind = [
      {
        title: "Missing kind",
        nodes: [{ label: "step", change: "added", citations: ["h1"] }],
      },
    ];
    expect(v.safeParse(briefFlowOutputSchema, noKind).success).toBe(false);
  });

  it("rejects a proposal nested 4 deep at the schema level, whole and unparsed", () => {
    const tooDeep = [
      {
        kind: "call_tree",
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
    expect(v.safeParse(briefFlowOutputSchema, tooDeep).success).toBe(false);
  });

  it("does not throw when a proposal chains 2000 levels deep", () => {
    type DeepRawNode = {
      label: string;
      change: "unchanged";
      children?: [DeepRawNode];
    };
    let node: DeepRawNode = { label: "bottom", change: "unchanged" };
    for (let index = 0; index < 2000; index += 1)
      node = {
        label: `n${String(index)}`,
        change: "unchanged",
        children: [node],
      };
    const tooDeep = [{ kind: "call_tree", title: "Deep chain", nodes: [node] }];
    let result: v.SafeParseResult<typeof briefFlowOutputSchema> | undefined;
    expect(() => {
      result = v.safeParse(briefFlowOutputSchema, tooDeep);
    }).not.toThrow();
    expect(result?.success).toBe(false);
  });

  it("drops nodes past the 15-node-per-tree cap, and does not count them rejected", () => {
    const nodes = Array.from({ length: 20 }, (_, index) => {
      const label = `Step ${String(index + 1)}`;
      if (index === 0)
        return { label, change: "added" as const, citations: ["h1"] };
      return { label, change: "unchanged" as const };
    });
    const raw: BriefFlowOutput = [
      { kind: "call_tree", title: "Too many steps", nodes },
    ];
    const result = normalize(raw);
    expect(result.value?.trees[0]?.nodes).toHaveLength(15);
    expect(result.rejected).toBe(0);
  });

  it("keeps a 100-character label whole", () => {
    const raw: BriefFlowOutput = [
      {
        kind: "call_tree",
        title: "Long label",
        nodes: [
          { label: "keep this step", change: "added", citations: ["h1"] },
          { label: "x".repeat(100), change: "unchanged" },
        ],
      },
    ];
    const result = normalize(raw);
    expect(result.rejected).toBe(0);
    expect(result.value?.trees[0]?.nodes.map((node) => node.label)).toEqual([
      "keep this step",
      "x".repeat(100),
    ]);
  });

  it("truncates a label longer than 120 characters instead of dropping it", () => {
    const raw: BriefFlowOutput = [
      {
        kind: "call_tree",
        title: "Long label",
        nodes: [
          { label: "keep this step", change: "added", citations: ["h1"] },
          { label: "x".repeat(121), change: "unchanged" },
        ],
      },
    ];
    const result = normalize(raw);
    expect(result.rejected).toBe(0);
    expect(result.value?.trees[0]?.nodes.map((node) => node.label)).toEqual([
      "keep this step",
      "x".repeat(120),
    ]);
  });

  it("drops a node whose label is only whitespace, and does not count it rejected", () => {
    const raw: BriefFlowOutput = [
      {
        kind: "call_tree",
        title: "Blank label",
        nodes: [
          { label: "valid change", change: "added", citations: ["h1"] },
          { label: "   ", change: "unchanged" },
        ],
      },
    ];
    const result = normalize(raw);
    expect(result.rejected).toBe(0);
    expect(result.value?.trees[0]?.nodes.map((node) => node.label)).toEqual([
      "valid change",
    ]);
  });

  it("returns no value and rejects nothing when the model offers no flow", () => {
    const result = normalize(undefined);
    expect(result.value).toBeUndefined();
    expect(result.rejected).toBe(0);
  });
});
