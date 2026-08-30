import { describe, expect, it } from "vitest";

import {
  briefManifest,
  normalizeBrief,
  renderBriefManifest,
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
