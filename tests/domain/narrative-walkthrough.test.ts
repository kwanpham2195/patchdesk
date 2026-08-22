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
  ' test("before", () => {',
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
  parseReviewSessionId(
    "github.com__centraldigital__patchdesk__pr-42__sha-abcdef12__base-12345678__0123456789ab",
  ),
);
const HEAD_SHA: GitSha = value(
  parseGitSha("abcdef1234567890abcdef1234567890abcdef12"),
);
const PATCH_HASH: ContentHash = value(parseContentHash("a".repeat(64)));
const SNAPSHOT: NarrativeSnapshot = {
  profileId: PROFILE_ID,
  sessionId: SESSION_ID,
  headSha: HEAD_SHA,
  patchHash: PATCH_HASH,
};

const RAW = {
  citationVersion: 2,
  title: "Recovery walkthrough",
  focus: "Follow the recovery decision before checking the tests.",
  snapshot: SNAPSHOT,
  chapters: [
    {
      title: "Context",
      sections: [
        {
          title: "Truthful states",
          prose:
            "src/recovery.ts now exposes one next action across its recovery hunks.",
          hunkIds: ["h1", "h1", "unknown", "h2"],
        },
      ],
    },
    {
      title: "Validation",
      sections: [
        {
          title: "Proof",
          prose: "tests/recovery.test.ts covers the focused transition proof.",
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
    expect(result.value.chapters.map((chapter) => chapter.title)).toEqual([
      "Context",
      "Validation",
    ]);
    expect(result.value.chapters[0]?.sections[0]?.hunkIds).toEqual([
      "h1",
      "h2",
    ]);
    expect(result.value.support.hunkIds).toEqual([]);

    const covered = [
      ...result.value.chapters.flatMap((chapter) =>
        chapter.sections.flatMap((section) => section.hunkIds),
      ),
      ...result.value.support.hunkIds,
    ];
    expect(covered).toEqual(["h1", "h2", "h3"]);
    expect(new Set(covered).size).toBe(3);
  });

  it("marks retained output from before alias manifests as unverified and routes its hunks to Support", () => {
    const legacy = { ...RAW, citationVersion: undefined };
    const result = normalizeNarrativeWalkthrough(legacy, PATCH, SNAPSHOT);
    expect(result).toMatchObject({
      _tag: "ok",
      value: {
        citationStatus: "unverified",
        support: { hunkIds: ["h1", "h2", "h3"] },
      },
    });
    if (result._tag === "ok")
      expect(result.value.chapters[0]?.sections[0]?.hunks).toEqual([]);
  });

  it("derives Support for non-mentioned hunks and drops duplicate or unknown references", () => {
    const result = normalizeNarrativeWalkthrough(
      {
        ...RAW,
        chapters: [
          {
            title: "Context",
            sections: [
              {
                title: "One idea",
                prose: "src/recovery.ts comes first.",
                hunkIds: ["h2", "h2", "missing"],
              },
            ],
          },
          {
            title: "Later",
            sections: [
              {
                title: "Duplicate",
                prose: "tests/recovery.test.ts cannot reclaim h2.",
                hunkIds: ["h2", "h3"],
              },
            ],
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
        {
          ...RAW,
          snapshot: {
            ...SNAPSHOT,
            headSha: "0123456789012345678901234567890123456789",
          },
        },
        PATCH,
        SNAPSHOT,
      ),
    ).toMatchObject({ _tag: "err", error: { reason: "stale_snapshot" } });

    expect(
      normalizeNarrativeWalkthrough(
        {
          ...RAW,
          chapters: [
            {
              title: "Empty",
              sections: [
                { title: "No hunks", prose: "", hunkIds: ["missing"] },
              ],
            },
          ],
        },
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
    ).toMatchObject({ _tag: "err", error: { reason: "malformed" } });
  });

  it.each([
    ["focus", { ...RAW, focus: "x".repeat(2_001) }],
    [
      "chapter title",
      { ...RAW, chapters: [{ ...RAW.chapters[0], title: "x".repeat(81) }] },
    ],
    [
      "section title",
      {
        ...RAW,
        chapters: [
          {
            ...RAW.chapters[0],
            sections: [
              { ...RAW.chapters[0]?.sections[0], title: "x".repeat(161) },
            ],
          },
        ],
      },
    ],
    [
      "prose",
      {
        ...RAW,
        chapters: [
          {
            ...RAW.chapters[0],
            sections: [
              { ...RAW.chapters[0]?.sections[0], prose: "x".repeat(4_001) },
            ],
          },
        ],
      },
    ],
    [
      "chapter count",
      { ...RAW, chapters: Array.from({ length: 13 }, () => RAW.chapters[0]) },
    ],
    [
      "section count",
      {
        ...RAW,
        chapters: [
          {
            ...RAW.chapters[0],
            sections: Array.from(
              { length: 33 },
              () => RAW.chapters[0]?.sections[0],
            ),
          },
        ],
      },
    ],
    [
      "hunk-id count",
      {
        ...RAW,
        chapters: [
          {
            ...RAW.chapters[0],
            sections: [
              {
                ...RAW.chapters[0]?.sections[0],
                hunkIds: Array.from({ length: 33 }, () => "h1"),
              },
            ],
          },
        ],
      },
    ],
    [
      "hunk-id length",
      {
        ...RAW,
        chapters: [
          {
            ...RAW.chapters[0],
            sections: [
              {
                ...RAW.chapters[0]?.sections[0],
                hunkIds: ["h" + "1".repeat(32)],
              },
            ],
          },
        ],
      },
    ],
    ["snapshot-id length", { ...RAW, snapshotId: "x".repeat(401) }],
  ] as const)(
    "rejects oversized raw %s at the schema boundary",
    (_label, input) => {
      expect(
        normalizeNarrativeWalkthrough(input, PATCH, SNAPSHOT),
      ).toMatchObject({ _tag: "err", error: { reason: "malformed" } });
    },
  );

  it("rejects malformed snapshot identity and accepts both supported snapshot-id forms", () => {
    expect(
      normalizeNarrativeWalkthrough(
        { ...RAW, snapshot: { ...SNAPSHOT, headSha: "bad" } },
        PATCH,
        SNAPSHOT,
      ),
    ).toMatchObject({ _tag: "err", error: { reason: "malformed_snapshot" } });
    expect(
      normalizeNarrativeWalkthrough(
        { ...RAW, snapshotId: "wrong" },
        PATCH,
        SNAPSHOT,
      ),
    ).toMatchObject({ _tag: "err", error: { reason: "stale_snapshot" } });
    expect(
      normalizeNarrativeWalkthrough(
        { ...RAW, snapshotId: SNAPSHOT.sessionId },
        PATCH,
        SNAPSHOT,
      )._tag,
    ).toBe("ok");
    expect(
      normalizeNarrativeWalkthrough(
        {
          ...RAW,
          snapshotId: [
            SNAPSHOT.profileId,
            SNAPSHOT.sessionId,
            SNAPSHOT.headSha,
            SNAPSHOT.patchHash,
          ].join(":"),
        },
        PATCH,
        SNAPSHOT,
      )._tag,
    ).toBe("ok");
  });

  it("rejects malformed, invalid, oversized, and mismatched unified-diff ranges", () => {
    const cases = [
      PATCH.replace("@@ -1,2 +1,3 @@", "@@ -0,1 +1,3 @@"),
      PATCH.replace("@@ -1,2 +1,3 @@", "@@ -1,-2 +1,3 @@"),
      PATCH.replace("@@ -1,2 +1,3 @@", "@@ -1,1000001 +1,3 @@"),
      PATCH.replace("@@ -1,2 +1,3 @@", "@@ -1,3 +1,3 @@"),
      PATCH.replace("@@ -1,2 +1,3 @@", "@@ -1,2 +1,3 @@\n? malformed"),
    ];
    for (const [index, patch] of cases.entries()) {
      expect(
        normalizeNarrativeWalkthrough(RAW, patch, SNAPSHOT),
        `invalid patch case ${index}`,
      ).toMatchObject({ _tag: "err", error: { reason: "invalid_patch" } });
    }
  });

  it("accepts valid zero-count ranges and preserves exact coordinates", () => {
    const patch = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "",
    ].join("\n");
    const result = normalizeNarrativeWalkthrough(
      {
        ...RAW,
        chapters: [
          {
            title: "Context",
            sections: [
              { title: "New", prose: "new.ts was added.", hunkIds: ["h1"] },
            ],
          },
        ],
      },
      patch,
      SNAPSHOT,
    );
    expect(result._tag).toBe("ok");
    if (result._tag === "ok") {
      expect(result.value.chapters[0]?.sections[0]?.hunks[0]).toMatchObject({
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 2,
      });
    }
  });

  it("filters reverse requested ids in source order and preserves the source patch", () => {
    const original = PATCH;
    const filtered = filterNarrativePatchToHunks(PATCH, ["h3", "h1"]);
    expect(filtered.indexOf("@@ -1,2 +1,3 @@")).toBeLessThan(
      filtered.indexOf("@@ -3,2 +3,3 @@"),
    );
    expect(parseUnifiedPatch(filtered)).toHaveLength(2);
    expect(PATCH).toBe(original);
  });

  it("filters a malformed patch to an empty result instead of exposing coordinates", () => {
    expect(
      filterNarrativePatchToHunks(
        PATCH.replace("@@ -1,2 +1,3 @@", "@@ -0,1 +1,3 @@"),
        ["h1"],
      ),
    ).toBe("");
  });

  it("tolerates bare git submodule metadata lines after the last hunk", () => {
    const patch = [
      "diff --git a/sql/000026_visit_route_planning.up.sql b/sql/000026_visit_route_planning.up.sql",
      "new file mode 100644",
      "index 00000000..8ffad242",
      "--- /dev/null",
      "+++ b/sql/000026_visit_route_planning.up.sql",
      "@@ -0,0 +1,2 @@",
      "+BEGIN;",
      "+COMMIT;",
      "Submodule yim-proto-hub 00000000...4619420d (new submodule)",
      "",
    ].join("\n");
    const result = normalizeNarrativeWalkthrough(
      {
        ...RAW,
        chapters: [
          {
            title: "Context",
            sections: [
              {
                title: "Migration",
                prose: "New SQL in sql/000026_visit_route_planning.up.sql",
                hunkIds: ["h1"],
              },
            ],
          },
        ],
      },
      patch,
      SNAPSHOT,
    );
    expect(result._tag).toBe("ok");
    if (result._tag === "ok") {
      expect(result.value.chapters[0]?.sections[0]?.hunks).toHaveLength(1);
      expect(result.value.chapters[0]?.sections[0]?.hunks[0]?.path).toBe(
        "sql/000026_visit_route_planning.up.sql",
      );
      expect(result.value.support.hunks).toHaveLength(0);
    }
  });
});
