import { describe, expect, it } from "vitest";

import {
  briefManifest,
  normalizeBrief,
  renderBriefManifest,
  MAX_CITED_HUNKS_TOTAL_LENGTH,
  type BriefError,
  type BriefOutput,
  type BriefSnapshot,
  type NormalizedBrief,
} from "../../src/domain/brief";
import {
  parseContentHash,
  parseGitSha,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { insightOutputGuidance } from "../../src/domain/insight-output-guidance";
import { filterNarrativePatchToHunks } from "../../src/domain/narrative-walkthrough";
import type { Result } from "../../src/domain/result";
import { parseStoredBrief } from "../../src/domain/stored-brief";

const PATCH = [
  "diff --git a/src/recovery.ts b/src/recovery.ts",
  "index 1111111..2222222 100644",
  "--- a/src/recovery.ts",
  "+++ b/src/recovery.ts",
  "@@ -1,2 +1,3 @@",
  " const before = true;",
  "+const first = true;",
  " ",
  "@@ -20,2 +21,3 @@",
  " const middle = true;",
  "+const second = true;",
  " ",
  "",
].join("\n");

const DESCRIPTION = [
  "Recovery could not restart after a crash.",
  "",
  "This adds the guard and its regression test.",
].join("\n");

function value<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("test fixture failed");
  return result.value;
}

const SNAPSHOT: BriefSnapshot = {
  profileId: value(parseWorkspaceProfileId("design")),
  sessionId: value(
    parseReviewSessionId(
      "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__base-12345678__0123456789ab",
    ),
  ),
  headSha: value(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
  patchHash: value(parseContentHash("a".repeat(64))),
};

const MANIFEST = briefManifest({
  patch: PATCH,
  description: DESCRIPTION,
  commits: [
    { sha: "1234567890abcdef", subject: "fix: guard recovery" },
    { sha: "abcdef1234567890", subject: "test: cover the guard" },
  ],
});

describe("briefManifest", () => {
  it("gives hunks, description paragraphs, and commits their own alias namespaces", () => {
    expect(MANIFEST.map((entry) => entry.alias)).toEqual([
      "h1",
      "h2",
      "d1",
      "d2",
      "c1",
      "c2",
    ]);
    expect(MANIFEST.map((entry) => entry.kind)).toEqual([
      "hunk",
      "hunk",
      "description",
      "description",
      "commit",
      "commit",
    ]);
    expect(MANIFEST[0]?.path).toBe("src/recovery.ts");
    expect(MANIFEST[2]?.label).toBe(
      "Recovery could not restart after a crash.",
    );
    expect(MANIFEST[4]?.label).toBe("1234567 fix: guard recovery");
  });

  it("still offers description and commit aliases when the patch cannot be indexed", () => {
    const manifest = briefManifest({
      patch: "not a patch",
      description: "Only prose.",
      commits: [{ sha: "1234567890abcdef", subject: "chore: nothing" }],
    });
    expect(manifest.map((entry) => entry.alias)).toEqual(["d1", "c1"]);
  });

  it("renders one alias, kind, and label per line", () => {
    expect(renderBriefManifest(MANIFEST).split("\n")).toHaveLength(6);
    expect(renderBriefManifest(MANIFEST)).toContain(
      "d2 | description | This adds the guard and its regression test.",
    );
  });
});

describe("normalizeBrief", () => {
  it("marks a Brief verified when every citation resolves", () => {
    const normalized = normalizeBrief(
      {
        goal: [
          { text: "Recovery restarts after a crash.", citations: ["d1", "h1"] },
          { text: "A regression test covers the guard.", citations: ["c2"] },
        ],
        assumptions: ["The crash was seen in production."],
      },
      MANIFEST,
      PATCH,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    expect(normalized.value.citationStatus).toBe("verified");
    expect(normalized.value.goal).toHaveLength(2);
    expect(normalized.value.goal[0]?.citations.map((c) => c.alias)).toEqual([
      "d1",
      "h1",
    ]);
    expect(normalized.value.assumptions).toEqual([
      { text: "The crash was seen in production.", demoted: false },
    ]);
    expect(normalized.value.snapshot).toEqual(SNAPSHOT);
  });

  it("demotes an uncited sentence to an assumption and reports partial verification", () => {
    const normalized = normalizeBrief(
      {
        goal: [
          { text: "Recovery restarts after a crash.", citations: ["h1"] },
          { text: "The team wanted this for the launch.", citations: [] },
        ],
        assumptions: [],
      },
      MANIFEST,
      PATCH,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    expect(normalized.value.citationStatus).toBe("partially_verified");
    expect(normalized.value.goal.map((item) => item.text)).toEqual([
      "Recovery restarts after a crash.",
    ]);
    expect(normalized.value.assumptions).toEqual([
      { text: "The team wanted this for the launch.", demoted: true },
    ]);
  });

  it("rejects a Brief whose every sentence is uncited", () => {
    expect(
      normalizeBrief(
        {
          goal: [{ text: "The team wanted this.", citations: [] }],
          assumptions: [],
        },
        MANIFEST,
        PATCH,
        SNAPSHOT,
      ),
    ).toEqual({
      _tag: "err",
      error: { _tag: "InvalidBrief", reason: "uncited" },
    });
  });

  it("drops an alias that is not manifest syntax instead of failing the run", () => {
    const normalized = normalizeBrief(
      {
        goal: [
          {
            text: "Recovery restarts after a crash.",
            citations: ["src/recovery.ts", "h9", "h1"],
          },
        ],
        assumptions: [],
      },
      MANIFEST,
      PATCH,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    expect(normalized.value.goal[0]?.citations.map((c) => c.alias)).toEqual([
      "h1",
    ]);
    expect(normalized.value.citationStatus).toBe("partially_verified");
  });

  it("rejects output that is not the Brief schema", () => {
    expect(
      normalizeBrief({ goal: "one sentence" }, MANIFEST, PATCH, SNAPSHOT),
    ).toEqual({
      _tag: "err",
      error: { _tag: "InvalidBrief", reason: "malformed" },
    });
  });

  it("round-trips through the stored-Brief parser", () => {
    const normalized = normalizeBrief(
      {
        goal: [
          { text: "Recovery restarts after a crash.", citations: ["h1", "d1"] },
        ],
        assumptions: ["The crash was seen in production."],
        reachSymbols: ["recover"],
      },
      MANIFEST,
      PATCH,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    expect(normalized.value.descriptionDrift).toBeUndefined();
    expect(normalized.value.ownership?.files).toHaveLength(1);
    expect(
      parseStoredBrief(JSON.parse(JSON.stringify(normalized.value))),
    ).toEqual({ _tag: "ok", value: normalized.value });
  });

  it("still reads a Brief retained before the Ownership block existed", () => {
    const normalized = normalizeBrief(
      {
        goal: [{ text: "Recovery restarts after a crash.", citations: ["h1"] }],
        assumptions: [],
      },
      MANIFEST,
      PATCH,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    const { ownership, ...withoutOwnership } = normalized.value;
    expect(ownership).toBeDefined();
    expect(
      parseStoredBrief(JSON.parse(JSON.stringify(withoutOwnership))),
    ).toEqual({
      _tag: "ok",
      value: withoutOwnership,
    });
  });
});

describe("normalizeBrief description drift", () => {
  const GOAL = [
    { text: "Recovery restarts after a crash.", citations: ["h1"] },
  ];

  function drift(
    descriptionDrift: BriefOutput["descriptionDrift"],
    manifest = MANIFEST,
  ): NormalizedBrief {
    const normalized = normalizeBrief(
      { goal: GOAL, assumptions: [], descriptionDrift },
      manifest,
      PATCH,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    return normalized.value;
  }

  it("keeps a claimed item that quotes a description paragraph", () => {
    const normalized = drift({
      claimed: [
        {
          quote: "This adds the guard and its regression test.",
          citations: ["d2", "h1"],
          note: "No guard appears on an added line.",
        },
      ],
      undescribed: [],
    });
    expect(
      normalized.descriptionDrift?.claimed.map((item) => ({
        quote: item.quote,
        aliases: item.citations.map((citation) => citation.alias),
      })),
    ).toEqual([
      {
        quote: "This adds the guard and its regression test.",
        aliases: ["d2", "h1"],
      },
    ]);
    expect(normalized.citationStatus).toBe("verified");
  });

  it("drops a claimed item that cites no description paragraph", () => {
    const normalized = drift({
      claimed: [
        {
          quote: "This adds the guard.",
          citations: ["h1", "h2"],
          note: "No guard appears on an added line.",
        },
      ],
      undescribed: [],
    });
    expect(normalized.descriptionDrift?.claimed).toEqual([]);
    expect(normalized.citationStatus).toBe("partially_verified");
  });

  it("keeps an undescribed item that cites a hunk", () => {
    const normalized = drift({
      claimed: [],
      undescribed: [{ text: "A second constant is added.", citations: ["h2"] }],
    });
    expect(
      normalized.descriptionDrift?.undescribed.map((item) => item.text),
    ).toEqual(["A second constant is added."]);
    expect(normalized.citationStatus).toBe("verified");
  });

  it("drops an undescribed item that cites only the description", () => {
    const normalized = drift({
      claimed: [],
      undescribed: [{ text: "A second constant is added.", citations: ["d1"] }],
    });
    expect(normalized.descriptionDrift?.undescribed).toEqual([]);
    expect(normalized.citationStatus).toBe("partially_verified");
  });

  it("omits the whole block when the pull request has no description", () => {
    const normalized = drift(
      {
        claimed: [
          {
            quote: "This adds the guard.",
            citations: ["d1"],
            note: "Nothing to compare.",
          },
        ],
        undescribed: [
          { text: "A second constant is added.", citations: ["h2"] },
        ],
      },
      briefManifest({ patch: PATCH, commits: [] }),
    );
    expect(normalized.descriptionDrift).toBeUndefined();
    expect(normalized.citationStatus).toBe("verified");
  });

  it("round-trips the drift block through the stored-Brief parser", () => {
    const normalized = drift({
      claimed: [
        {
          quote: "This adds the guard and its regression test.",
          citations: ["d2"],
          note: "No guard appears on an added line.",
        },
      ],
      undescribed: [{ text: "A second constant is added.", citations: ["h2"] }],
    });
    expect(parseStoredBrief(JSON.parse(JSON.stringify(normalized)))).toEqual({
      _tag: "ok",
      value: normalized,
    });
  });
});

describe("insightOutputGuidance", () => {
  it("gives the Brief its own evidence rule and leaves the Walkthrough unchanged", () => {
    expect(insightOutputGuidance("brief")).toContain("Cite every sentence.");
    expect(insightOutputGuidance("brief")).not.toContain("walkthrough");
    expect(insightOutputGuidance("walkthrough")).toContain(
      "short semantic walkthrough",
    );
    expect(insightOutputGuidance("walkthrough")).not.toContain(
      "Cite every sentence.",
    );
  });

  it("keeps verification results out of the Brief's description drift", () => {
    const guidance = insightOutputGuidance("brief");
    expect(guidance).toContain(
      "list a claim about behavior -- what the code does, or no longer does",
    );
    expect(guidance).toContain(
      "Do not put a claim about a build, a test run, a benchmark, lint, CI, a screenshot, or a manual check in descriptionDrift.claimed.",
    );
  });

  it("gives the Brief its own Flow rules and still forbids numbers", () => {
    const guidance = insightOutputGuidance("brief");
    expect(guidance).toContain(
      "In flow, give at most one tree of each kind that the patch changes: call_tree, control_flow, and component.",
    );
    expect(guidance).toContain(
      "A call_tree step is the real function or method name with its parameter names as written in the patch, such as validateManualDays(command, suggestion)",
    );
    expect(guidance).toContain(
      "Give every added or removed step an h alias citing the hunk that adds or removes it; a description or commit alias does not count for flow",
    );
    expect(guidance).toContain(
      "omit flow entirely when the patch adds, removes, or reorders no step, such as a rename, a docs change, or a pure refactor.",
    );
    expect(guidance).toContain("Write no numbers and no counts.");
  });
});

describe("normalizeBrief start here", () => {
  const GOAL = [
    { text: "Recovery restarts after a crash.", citations: ["h1"] },
  ];

  /** One hunk per file, so `briefOwnershipFiles` keeps each of them. */
  function patchOf(paths: ReadonlyArray<string>): string {
    return paths
      .flatMap((path) => [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -1 +1,2 @@",
        " const before = true;",
        "+const after = true;",
      ])
      .concat("")
      .join("\n");
  }

  function startHere(
    raw: BriefOutput["startHere"],
    patch = PATCH,
  ): NormalizedBrief {
    const normalized = normalizeBrief(
      { goal: GOAL, assumptions: [], startHere: raw },
      briefManifest({ patch, commits: [] }),
      patch,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    return normalized.value;
  }

  it("keeps only the proposed paths the patch changes, in the proposed order", () => {
    const normalized = startHere({
      lead: "  Read the guard first.  ",
      order: [
        { path: "src/nowhere.ts", why: "not in this patch" },
        { path: "src/recovery.ts", why: "  owns the guard  " },
        { path: "src/recovery.ts", why: "the same file again" },
      ],
    });
    expect(normalized.startHere).toEqual({
      lead: "Read the guard first.",
      order: [{ path: "src/recovery.ts", why: "owns the guard" }],
    });
    expect(parseStoredBrief(JSON.parse(JSON.stringify(normalized)))).toEqual({
      _tag: "ok",
      value: normalized,
    });
  });

  it("keeps a file the model gave no reason for", () => {
    expect(
      startHere({
        lead: "Start at the guard.",
        order: [{ path: "src/recovery.ts" }],
      }).startHere?.order,
    ).toEqual([{ path: "src/recovery.ts" }]);
  });

  it("drops the block and counts it when no proposed path is a changed file", () => {
    const normalized = startHere({
      lead: "Read the router first.",
      order: [{ path: "src/router.ts", why: "it is not in this patch" }],
    });
    expect(normalized.startHere).toBeUndefined();
    expect(normalized.citationStatus).toBe("partially_verified");
  });

  it("caps the reading order at five files", () => {
    const paths = Array.from({ length: 7 }, (_, index) => `src/f${index}.ts`);
    const normalized = startHere(
      {
        lead: "Read them in this order.",
        order: paths.map((path) => ({ path })),
      },
      patchOf(paths),
    );
    expect(normalized.startHere?.order.map((entry) => entry.path)).toEqual(
      paths.slice(0, 5),
    );
    expect(normalized.citationStatus).toBe("verified");
  });

  it("leaves the block absent, and the Brief verified, when the model omits it", () => {
    const normalized = startHere(undefined);
    expect(normalized.startHere).toBeUndefined();
    expect(normalized.citationStatus).toBe("verified");
  });
});

describe("normalizeBrief flow", () => {
  const GOAL = [
    { text: "Recovery restarts after a crash.", citations: ["h1"] },
  ];

  it("normalizes a proposed flow, surfacing its hunk citations in citedHunks", () => {
    const normalized = normalizeBrief(
      {
        goal: GOAL,
        assumptions: [],
        flow: [
          {
            kind: "call_tree",
            title: "Recovery",
            nodes: [
              {
                label: "guard the restart",
                change: "added",
                citations: ["h2"],
              },
            ],
          },
        ],
      },
      MANIFEST,
      PATCH,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    expect(normalized.value.flow?.trees[0]?.kind).toBe("call_tree");
    expect(normalized.value.flow?.trees[0]?.nodes[0]?.label).toBe(
      "guard the restart",
    );
    expect(normalized.value.citedHunks?.h2).toBe(
      filterNarrativePatchToHunks(PATCH, ["h2"]),
    );
  });

  it("round-trips a flow through the stored-Brief parser", () => {
    const normalized = normalizeBrief(
      {
        goal: GOAL,
        assumptions: [],
        flow: [
          {
            kind: "call_tree",
            title: "Recovery",
            nodes: [
              {
                label: "guard the restart",
                change: "added",
                citations: ["h1"],
              },
            ],
          },
        ],
      },
      MANIFEST,
      PATCH,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    expect(normalized.value.flow).toBeDefined();
    expect(
      parseStoredBrief(JSON.parse(JSON.stringify(normalized.value))),
    ).toEqual({ _tag: "ok", value: normalized.value });
  });

  it("still reads a stored Brief with no flow", () => {
    const normalized = normalizeBrief(
      { goal: GOAL, assumptions: [] },
      MANIFEST,
      PATCH,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    expect(normalized.value.flow).toBeUndefined();
    expect(
      parseStoredBrief(JSON.parse(JSON.stringify(normalized.value))),
    ).toEqual({ _tag: "ok", value: normalized.value });
  });

  it("rejects nothing and stays verified for three fully cited trees of three kinds", () => {
    const normalized = normalizeBrief(
      {
        goal: GOAL,
        assumptions: [],
        flow: [
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
            nodes: [
              { label: "change C", change: "removed", citations: ["h1"] },
            ],
          },
        ],
      },
      MANIFEST,
      PATCH,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    // All three survive `MAX_FLOW_TREES` because each is a different kind.
    expect(normalized.value.flow?.trees.map((tree) => tree.title)).toEqual([
      "Tree A",
      "Tree B",
      "Tree C",
    ]);
    expect(normalized.value.citationStatus).toBe("verified");
  });

  it("keeps only the first of two same-kind trees, past the one-per-kind cap", () => {
    const normalized = normalizeBrief(
      {
        goal: GOAL,
        assumptions: [],
        flow: [
          {
            kind: "call_tree",
            title: "Tree A",
            nodes: [{ label: "change A", change: "added", citations: ["h1"] }],
          },
          {
            kind: "call_tree",
            title: "Tree B",
            nodes: [{ label: "change B", change: "added", citations: ["h2"] }],
          },
        ],
      },
      MANIFEST,
      PATCH,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    expect(normalized.value.flow?.trees.map((tree) => tree.title)).toEqual([
      "Tree A",
    ]);
    expect(normalized.value.citationStatus).toBe("verified");
  });

  it("does not throw when flow proposes 2000 levels of nesting, and rejects the whole Brief as malformed", () => {
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
    let normalized: Result<NormalizedBrief, BriefError> | undefined;
    expect(() => {
      normalized = normalizeBrief(
        {
          goal: GOAL,
          assumptions: [],
          flow: [{ kind: "call_tree", title: "Deep chain", nodes: [node] }],
        },
        MANIFEST,
        PATCH,
        SNAPSHOT,
      );
    }).not.toThrow();
    expect(normalized).toEqual({
      _tag: "err",
      error: { _tag: "InvalidBrief", reason: "malformed" },
    });
  });
});

describe("normalizeBrief cited hunks", () => {
  /** A patch with one small hunk (h1) and one hunk (h2) past `MAX_CITED_HUNK_RAW_LENGTH`. */
  function patchWithHugeHunk(): string {
    const hugeLines = Array.from(
      { length: 3_000 },
      (_, index) => `+const huge${String(index)} = ${String(index)};`,
    );
    const newCount = 1 + hugeLines.length;
    return [
      "diff --git a/src/recovery.ts b/src/recovery.ts",
      "--- a/src/recovery.ts",
      "+++ b/src/recovery.ts",
      "@@ -1,1 +1,2 @@",
      " const before = true;",
      "+const first = true;",
      "diff --git a/src/huge.ts b/src/huge.ts",
      "--- a/src/huge.ts",
      "+++ b/src/huge.ts",
      `@@ -1,1 +1,${String(newCount)} @@`,
      " const before = true;",
      ...hugeLines,
      "",
    ].join("\n");
  }

  /** `fileCount` files, each with one same-size hunk, so every cut hunk is the same length. */
  function patchWithManyHunks(fileCount: number, linesPerHunk: number): string {
    const lines: Array<string> = [];
    for (let index = 0; index < fileCount; index += 1) {
      const path = `src/f${String(index)}.ts`;
      lines.push(
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        `@@ -1,1 +1,${String(linesPerHunk + 1)} @@`,
        " const before = true;",
        ...Array.from(
          { length: linesPerHunk },
          (_, line) => `+const v${String(line)} = ${String(line)};`,
        ),
      );
    }
    lines.push("");
    return lines.join("\n");
  }

  it("cuts the hunk a Goal cites into citedHunks, keyed by alias", () => {
    const normalized = normalizeBrief(
      {
        goal: [{ text: "Recovery restarts after a crash.", citations: ["h1"] }],
        assumptions: [],
      },
      MANIFEST,
      PATCH,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    expect(normalized.value.citedHunks?.h1).toBe(
      filterNarrativePatchToHunks(PATCH, ["h1"]),
    );
    expect(normalized.value.citedHunks?.h1).toContain("@@ -1,2 +1,3 @@");
  });

  it("omits citedHunks entirely when every citation is description or commit", () => {
    const normalized = normalizeBrief(
      {
        goal: [
          { text: "Recovery restarts after a crash.", citations: ["d1"] },
          { text: "A regression test covers the guard.", citations: ["c2"] },
        ],
        assumptions: [],
      },
      MANIFEST,
      PATCH,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    expect(Object.hasOwn(normalized.value, "citedHunks")).toBe(false);
  });

  it("keys one entry per alias however many items cite it", () => {
    const normalized = normalizeBrief(
      {
        goal: [{ text: "Recovery restarts after a crash.", citations: ["h1"] }],
        assumptions: [],
        descriptionDrift: {
          claimed: [],
          undescribed: [
            { text: "The same hunk also does this.", citations: ["h1"] },
          ],
        },
      },
      MANIFEST,
      PATCH,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    expect(Object.keys(normalized.value.citedHunks ?? {})).toEqual(["h1"]);
  });

  it("omits a cited hunk whose raw exceeds MAX_CITED_HUNK_RAW_LENGTH but keeps the rest", () => {
    const patch = patchWithHugeHunk();
    const normalized = normalizeBrief(
      {
        goal: [
          {
            text: "Recovery restarts after a crash.",
            citations: ["h1", "h2"],
          },
        ],
        assumptions: [],
      },
      briefManifest({ patch, commits: [] }),
      patch,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    expect(Object.keys(normalized.value.citedHunks ?? {})).toEqual(["h1"]);
  });

  it("stops cutting once the running total would cross MAX_CITED_HUNKS_TOTAL_LENGTH", () => {
    const fileCount = 30;
    const patch = patchWithManyHunks(fileCount, 700);
    const manifest = briefManifest({ patch, commits: [] });
    const aliases = manifest
      .filter((entry) => entry.kind === "hunk")
      .map((entry) => entry.alias);
    const goal: BriefOutput["goal"] = [];
    for (let start = 0; start < aliases.length; start += 8)
      goal.push({
        text: `Group starting at ${String(start)} restarts after a crash.`,
        citations: aliases.slice(start, start + 8),
      });
    const normalized = normalizeBrief(
      { goal, assumptions: [] },
      manifest,
      patch,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    const kept = Object.keys(normalized.value.citedHunks ?? {});
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(fileCount);
    expect(kept).toEqual(
      Array.from(
        { length: kept.length },
        (_, index) => `h${String(index + 1)}`,
      ),
    );
    const totalLength = Object.values(normalized.value.citedHunks ?? {}).reduce(
      (sum, raw) => sum + raw.length,
      0,
    );
    expect(totalLength).toBeLessThanOrEqual(MAX_CITED_HUNKS_TOTAL_LENGTH);
  });

  it("round-trips citedHunks through the stored-Brief parser", () => {
    const normalized = normalizeBrief(
      {
        goal: [{ text: "Recovery restarts after a crash.", citations: ["h1"] }],
        assumptions: [],
      },
      MANIFEST,
      PATCH,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    expect(normalized.value.citedHunks?.h1).toBeDefined();
    expect(
      parseStoredBrief(JSON.parse(JSON.stringify(normalized.value))),
    ).toEqual({ _tag: "ok", value: normalized.value });
  });

  it("still reads a stored Brief with no citedHunks", () => {
    const normalized = normalizeBrief(
      {
        goal: [{ text: "Recovery restarts after a crash.", citations: ["d1"] }],
        assumptions: [],
      },
      MANIFEST,
      PATCH,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    expect(Object.hasOwn(normalized.value, "citedHunks")).toBe(false);
    expect(
      parseStoredBrief(JSON.parse(JSON.stringify(normalized.value))),
    ).toEqual({ _tag: "ok", value: normalized.value });
  });
});
