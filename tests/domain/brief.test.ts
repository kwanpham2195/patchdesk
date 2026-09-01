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

const MANIFEST = briefManifest({ patch: PATCH });

describe("briefManifest", () => {
  it("builds h* aliases from the patch only -- ADR 0040 retired the two prose blocks that could cite d* or c*", () => {
    expect(MANIFEST.map((entry) => entry.alias)).toEqual(["h1", "h2"]);
    expect(MANIFEST.map((entry) => entry.kind)).toEqual(["hunk", "hunk"]);
    expect(MANIFEST[0]?.path).toBe("src/recovery.ts");
  });

  it("yields no aliases when the patch cannot be indexed", () => {
    expect(briefManifest({ patch: "not a patch" })).toEqual([]);
  });

  it("renders one alias, kind, and label per line", () => {
    expect(renderBriefManifest(MANIFEST).split("\n")).toHaveLength(2);
    expect(renderBriefManifest(MANIFEST)).toContain(
      "h1 | hunk | @@ -1,2 +1,3 @@",
    );
  });
});

describe("normalizeBrief", () => {
  it("returns ok with citationStatus verified when the model proposes nothing at all", () => {
    // A rename, a docs change, or a pure refactor proposes no Flow, Start
    // here, or Reach candidate. That is still a complete, valid Brief
    // (ADR 0040): normalizeBrief never rejects a Brief for lacking one.
    const normalized = normalizeBrief({}, MANIFEST, PATCH, SNAPSHOT);
    if (normalized._tag === "err") throw new Error("expected a Brief");
    expect(normalized.value.citationStatus).toBe("verified");
    expect(normalized.value.flow).toBeUndefined();
    expect(normalized.value.startHere).toBeUndefined();
    expect(normalized.value.ownership).toBeDefined();
    expect(normalized.value.snapshot).toEqual(SNAPSHOT);
  });

  it("rejects output that is not the Brief schema", () => {
    expect(
      normalizeBrief({ goal: "one sentence" }, MANIFEST, PATCH, SNAPSHOT),
    ).toEqual({
      _tag: "err",
      error: { _tag: "InvalidBrief", reason: "malformed" },
    });
  });

  it('no longer has an "uncited" reason', () => {
    // @ts-expect-error "uncited" is not assignable to BriefError["reason"] -- this fails to compile if that ever changes back.
    const invalidReason: BriefError["reason"] = "uncited";
    expect(invalidReason).toBe("uncited");
  });

  it("round-trips through the stored-Brief parser", () => {
    const normalized = normalizeBrief(
      { reachSymbols: ["recover"] },
      MANIFEST,
      PATCH,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    expect(normalized.value.ownership?.files).toHaveLength(1);
    expect(
      parseStoredBrief(JSON.parse(JSON.stringify(normalized.value))),
    ).toEqual({ _tag: "ok", value: normalized.value });
  });

  it("still reads a Brief retained before the Ownership block existed", () => {
    const normalized = normalizeBrief({}, MANIFEST, PATCH, SNAPSHOT);
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

  it("still parses a stored Brief carrying 0.1.3's goal, assumptions, and descriptionDrift keys, and returns none of them", () => {
    const stored = {
      snapshot: SNAPSHOT,
      citationStatus: "verified",
      goal: [{ text: "Recovery restarts after a crash.", citations: [] }],
      assumptions: [{ text: "Old assumption.", demoted: false }],
      descriptionDrift: { claimed: [], undescribed: [] },
    };
    const parsed = parseStoredBrief(stored);
    if (parsed._tag === "err") throw new Error("expected a Brief");
    expect(parsed.value).toEqual({
      snapshot: SNAPSHOT,
      citationStatus: "verified",
    });
    expect(Object.hasOwn(parsed.value, "goal")).toBe(false);
    expect(Object.hasOwn(parsed.value, "assumptions")).toBe(false);
    expect(Object.hasOwn(parsed.value, "descriptionDrift")).toBe(false);
  });
});

describe("insightOutputGuidance", () => {
  it("gives the Brief its own framing and leaves the Walkthrough unchanged", () => {
    expect(insightOutputGuidance("brief")).toContain(
      "Write a Brief: the structure of this change -- its flow, ownership, and where to start reading.",
    );
    expect(insightOutputGuidance("brief")).toContain(
      "Never invent motivation, intent, trade-offs, or product impact.",
    );
    expect(insightOutputGuidance("brief")).not.toContain(
      "Mark missing evidence as an assumption",
    );
    expect(insightOutputGuidance("brief")).not.toContain("walkthrough");
    expect(insightOutputGuidance("walkthrough")).toContain(
      "short semantic walkthrough",
    );
    expect(insightOutputGuidance("walkthrough")).toContain(
      "Never invent motivation, intent, trade-offs, or product impact. Mark missing evidence as an assumption or an unresolved item.",
    );
  });

  it("gives the Brief its own Flow rules and still forbids prose numbers", () => {
    const guidance = insightOutputGuidance("brief");
    expect(guidance).toContain(
      "In flow, give at most one tree of each kind that the patch changes: call_tree, control_flow, and component.",
    );
    expect(guidance).toContain(
      "each step is the real function or method name with its parameter names as written in the patch, such as validateManualDays(command, suggestion)",
    );
    expect(guidance).toContain(
      "Give an added or removed step the h alias of the hunk that shows it when the patch shows it, and leave citations empty when it does not -- never omit a step for lack of a citation, and never cite a description or commit alias in flow.",
    );
    expect(guidance).toContain(
      "omit flow entirely when the patch adds, removes, or reorders no step, such as a rename, a docs change, or a pure refactor.",
    );
    expect(guidance).toContain(
      "Write no numbers and no counts in prose; a flow label copies the identifier from the patch as written, digits included.",
    );
  });
});

describe("normalizeBrief start here", () => {
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
      { startHere: raw },
      briefManifest({ patch }),
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
  it("normalizes a proposed flow, surfacing its hunk citations in citedHunks", () => {
    const normalized = normalizeBrief(
      {
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

  it("keeps an uncited added step alongside a cited one and marks the Brief partially_verified", () => {
    const normalized = normalizeBrief(
      {
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
              {
                label: "log the retry",
                change: "added",
                citations: [],
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
    expect(normalized.value.flow?.trees[0]?.nodes).toHaveLength(2);
    expect(normalized.value.flow?.trees[0]?.nodes[0]?.label).toBe(
      "guard the restart",
    );
    expect(normalized.value.flow?.trees[0]?.nodes[1]?.label).toBe(
      "log the retry",
    );
    expect(normalized.value.citationStatus).toBe("partially_verified");
  });

  it("round-trips a flow through the stored-Brief parser", () => {
    const normalized = normalizeBrief(
      {
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
    const normalized = normalizeBrief({}, MANIFEST, PATCH, SNAPSHOT);
    if (normalized._tag === "err") throw new Error("expected a Brief");
    expect(normalized.value.flow).toBeUndefined();
    expect(
      parseStoredBrief(JSON.parse(JSON.stringify(normalized.value))),
    ).toEqual({ _tag: "ok", value: normalized.value });
  });

  it("rejects nothing and stays verified for three fully cited trees of three kinds", () => {
    const normalized = normalizeBrief(
      {
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

  it("cuts the hunk a Flow step cites into citedHunks, keyed by alias", () => {
    const normalized = normalizeBrief(
      {
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
    expect(normalized.value.citedHunks?.h1).toBe(
      filterNarrativePatchToHunks(PATCH, ["h1"]),
    );
    expect(normalized.value.citedHunks?.h1).toContain("@@ -1,2 +1,3 @@");
  });

  it("keys one entry per alias however many Flow steps cite it", () => {
    const normalized = normalizeBrief(
      {
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
              {
                label: "guard it again",
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
    expect(Object.keys(normalized.value.citedHunks ?? {})).toEqual(["h1"]);
  });

  it("omits a cited hunk whose raw exceeds MAX_CITED_HUNK_RAW_LENGTH but keeps the rest", () => {
    const patch = patchWithHugeHunk();
    const normalized = normalizeBrief(
      {
        flow: [
          {
            kind: "call_tree",
            title: "Recovery",
            nodes: [
              {
                label: "guard the restart",
                change: "added",
                citations: ["h1", "h2"],
              },
            ],
          },
        ],
      },
      briefManifest({ patch }),
      patch,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    expect(Object.keys(normalized.value.citedHunks ?? {})).toEqual(["h1"]);
  });

  it("stops cutting once the running total would cross MAX_CITED_HUNKS_TOTAL_LENGTH", () => {
    const fileCount = 30;
    const patch = patchWithManyHunks(fileCount, 700);
    const manifest = briefManifest({ patch });
    const aliases = manifest
      .filter((entry) => entry.kind === "hunk")
      .map((entry) => entry.alias);
    const nodes: Array<{
      label: string;
      change: "added";
      citations: Array<string>;
    }> = [];
    for (let start = 0; start < aliases.length; start += 8)
      nodes.push({
        label: `group starting at ${String(start)}`,
        change: "added",
        citations: aliases.slice(start, start + 8),
      });
    const normalized = normalizeBrief(
      { flow: [{ kind: "call_tree", title: "Recovery", nodes }] },
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
    expect(normalized.value.citedHunks?.h1).toBeDefined();
    expect(
      parseStoredBrief(JSON.parse(JSON.stringify(normalized.value))),
    ).toEqual({ _tag: "ok", value: normalized.value });
  });

  it("still reads a stored Brief with no citedHunks when Flow proposes only unchanged steps", () => {
    const normalized = normalizeBrief(
      {
        flow: [
          {
            kind: "call_tree",
            title: "Untouched",
            nodes: [{ label: "call something", change: "unchanged" }],
          },
        ],
      },
      MANIFEST,
      PATCH,
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    expect(normalized.value.flow).toBeUndefined();
    expect(Object.hasOwn(normalized.value, "citedHunks")).toBe(false);
    expect(
      parseStoredBrief(JSON.parse(JSON.stringify(normalized.value))),
    ).toEqual({ _tag: "ok", value: normalized.value });
  });
});
