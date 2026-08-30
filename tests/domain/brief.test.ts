import { describe, expect, it } from "vitest";

import {
  briefManifest,
  normalizeBrief,
  parseStoredBrief,
  renderBriefManifest,
  type BriefSnapshot,
} from "../../src/domain/brief";
import {
  parseContentHash,
  parseGitSha,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { insightOutputGuidance } from "../../src/domain/insight-output-guidance";
import type { Result } from "../../src/domain/result";

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
      normalizeBrief({ goal: "one sentence" }, MANIFEST, SNAPSHOT),
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
      SNAPSHOT,
    );
    if (normalized._tag === "err") throw new Error("expected a Brief");
    expect(
      parseStoredBrief(JSON.parse(JSON.stringify(normalized.value))),
    ).toEqual({ _tag: "ok", value: normalized.value });
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
});
