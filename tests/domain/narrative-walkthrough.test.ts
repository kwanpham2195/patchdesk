import { describe, expect, it } from "vitest";

import {
  normalizeNarrativeWalkthrough,
  filterNarrativePatchToHunks,
  type NarrativeSnapshot,
} from "../../src/domain/narrative-walkthrough";
import {
  parseContentHash,
  parseGitSha,
  parseReviewSessionId,
  parseWorkspaceProfileId,
  type ContentHash,
  type GitSha,
  type ReviewSessionId,
  type WorkspaceProfileId,
} from "../../src/domain/ids";
import { parseUnifiedPatch } from "../../src/domain/patch";
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
  "diff --git a/tests/recovery.test.ts b/tests/recovery.test.ts",
  "index 3333333..4444444 100644",
  "--- a/tests/recovery.test.ts",
  "+++ b/tests/recovery.test.ts",
  "@@ -3,2 +3,3 @@",
  " test(\"before\", () => {",
  "+  expect(true).toBe(true);",
  " });",
  "",
].join("\n");

function value<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("test fixture failed");
  return result.value;
}

const PROFILE_ID: WorkspaceProfileId = value(parseWorkspaceProfileId("design"));
const SESSION_ID: ReviewSessionId = value(
  parseReviewSessionId("github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__0123456789ab"),
);
const HEAD_SHA: GitSha = value(parseGitSha("abcdef1234567890abcdef1234567890abcdef12"));
const PATCH_HASH: ContentHash = value(parseContentHash("a".repeat(64)));
const SNAPSHOT: NarrativeSnapshot = {
  profileId: PROFILE_ID,
  sessionId: SESSION_ID,
  headSha: HEAD_SHA,
  patchHash: PATCH_HASH,
};

const RAW = {
  title: "Recovery walkthrough",
  focus: "Follow the recovery decision before checking the tests.",
  snapshot: SNAPSHOT,
  chapters: [
    {
      title: "Context",
      sections: [
        {
          title: "Truthful states",
          prose: "The workbench now exposes one next action.",
          hunkIds: ["h1", "h1", "unknown", "h2"],
        },
      ],
    },
    {
      title: "Validation",
      sections: [
        {
          title: "Proof",
          prose: "The focused tests cover the transition.",
          hunkIds: ["h3"],
        },
      ],
    },
  ],
};

describe("narrative walkthrough domain", () => {
  it("normalizes ordered chapters and covers every patch hunk once", () => {
    const result = normalizeNarrativeWalkthrough(RAW, PATCH, SNAPSHOT);

    expect(result._tag).toBe("ok");
    if (result._tag === "err") return;

    expect(result.value.snapshot).toEqual(SNAPSHOT);
    expect(result.value.chapters.map((chapter) => chapter.title)).toEqual(["Context", "Validation"]);
    expect(result.value.chapters[0]?.sections[0]?.hunkIds).toEqual(["h1", "h2"]);
    expect(result.value.support.hunkIds).toEqual([]);

    const covered = [
      ...result.value.chapters.flatMap((chapter) => chapter.sections.flatMap((section) => section.hunkIds)),
      ...result.value.support.hunkIds,
    ];
    expect(covered).toEqual(["h1", "h2", "h3"]);
    expect(new Set(covered).size).toBe(3);
  });

  it("derives Support for non-mentioned hunks and drops duplicate or unknown references", () => {
    const result = normalizeNarrativeWalkthrough(
      {
        ...RAW,
        chapters: [
          {
            title: "Context",
            sections: [{ title: "One idea", prose: "Read this first.", hunkIds: ["h2", "h2", "missing"] }],
          },
          {
            title: "Later",
            sections: [{ title: "Duplicate", prose: "This cannot reclaim h2.", hunkIds: ["h2", "h3"] }],
          },
        ],
      },
      PATCH,
      SNAPSHOT,
    );

    expect(result._tag).toBe("ok");
    if (result._tag === "err") return;
    expect(result.value.chapters[0]?.sections[0]?.hunkIds).toEqual(["h2"]);
    expect(result.value.chapters[1]?.sections[0]?.hunkIds).toEqual(["h3"]);
    expect(result.value.support.hunkIds).toEqual(["h1"]);
  });

  it("fails closed for stale snapshot identity and empty primary output", () => {
    expect(
      normalizeNarrativeWalkthrough(
        { ...RAW, snapshot: { ...SNAPSHOT, headSha: "0123456789012345678901234567890123456789" } },
        PATCH,
        SNAPSHOT,
      ),
    ).toMatchObject({ _tag: "err", error: { reason: "stale_snapshot" } });

    expect(
      normalizeNarrativeWalkthrough(
        { ...RAW, chapters: [{ title: "Empty", sections: [{ title: "No hunks", prose: "", hunkIds: ["missing"] }] }] },
        PATCH,
        SNAPSHOT,
      ),
    ).toMatchObject({ _tag: "err", error: { reason: "empty_primary" } });
  });

  it("rejects unbounded model fields", () => {
    expect(
      normalizeNarrativeWalkthrough(
        { ...RAW, title: "x".repeat(201) },
        PATCH,
        SNAPSHOT,
      ),
    ).toMatchObject({ _tag: "err", error: { reason: "bounds" } });
  });

  it("filters non-contiguous hunk blocks while preserving file headers and reparsable coordinates", () => {
    const filtered = filterNarrativePatchToHunks(PATCH, ["h1", "h3"]);

    expect(filtered).toContain("diff --git a/src/recovery.ts b/src/recovery.ts");
    expect(filtered).toContain("--- a/src/recovery.ts\n+++ b/src/recovery.ts");
    expect(filtered).toContain("@@ -1,2 +1,3 @@");
    expect(filtered).not.toContain("@@ -20,2 +21,3 @@");
    expect(filtered).toContain("diff --git a/tests/recovery.test.ts b/tests/recovery.test.ts");
    expect(parseUnifiedPatch(filtered)).toHaveLength(2);
    expect(PATCH).toContain("@@ -20,2 +21,3 @@");
  });
});
