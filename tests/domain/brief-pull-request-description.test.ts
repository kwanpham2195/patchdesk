import { describe, expect, it } from "vitest";

import {
  briefManifest,
  normalizeBrief,
  type BriefSnapshot,
  type NormalizedBrief,
} from "../../src/domain/brief";
import { renderBriefAsPullRequestDescription } from "../../src/domain/brief-pull-request-description";
import {
  parseContentHash,
  parseGitSha,
  parseRepoRelativePath,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";

function value<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("test fixture failed");
  return result.value;
}

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

const SNAPSHOT: BriefSnapshot = {
  profileId: value(parseWorkspaceProfileId("design")),
  sessionId: value(
    parseReviewSessionId(
      "github.com__octo-org__patchdesk__local-working_tree-main__sha-abcdef12__base-12345678__0123456789ab",
    ),
  ),
  headSha: value(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
  patchHash: value(parseContentHash("a".repeat(64))),
};

describe("renderBriefAsPullRequestDescription", () => {
  it("writes each changed step's hunk citations as path and new-side start line", () => {
    const brief = value(
      normalizeBrief(
        {
          ownership: {
            notes: [{ path: "src/recovery.ts", note: "Owns recovery." }],
          },
          startHere: {
            lead: "Read the recovery path first.",
            order: [{ path: "src/recovery.ts", why: "The entry point." }],
          },
          flow: [
            {
              kind: "call_tree",
              title: "Recovery",
              nodes: [
                {
                  label: "recover()",
                  change: "unchanged",
                  citations: ["h1"],
                  children: [
                    {
                      label: "writeFirst",
                      change: "added",
                      citations: ["h1"],
                      children: [],
                    },
                    {
                      // `h9` names no hunk, so normalization drops it before storage.
                      label: "writeSecond",
                      change: "added",
                      citations: ["h2", "h9"],
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
          reachSymbols: [],
        },
        briefManifest({ patch: PATCH }),
        PATCH,
        SNAPSHOT,
      ),
    );

    expect(renderBriefAsPullRequestDescription(brief)).toBe(
      [
        "## Flow",
        "",
        "### Call tree: Recovery",
        "",
        "```diff",
        "  recover()",
        "+ ├── writeFirst  (src/recovery.ts:1)",
        "+ └── writeSecond  (src/recovery.ts:21)",
        "```",
        "",
        "## Shape",
        "",
        "- `src/recovery.ts` (modified, +2 -0): Owns recovery.",
        "",
        "## Start here",
        "",
        "Read the recovery path first.",
        "",
        "1. `src/recovery.ts`: The entry point.",
        "",
      ].join("\n"),
    );
  });

  it("drops citations that name no hunk location and keeps a contract's citations on its root", () => {
    const hunk = (alias: string, path: string, label: string) => ({
      alias,
      kind: "hunk" as const,
      label,
      path: value(parseRepoRelativePath(path)),
    });
    const brief: NormalizedBrief = {
      snapshot: SNAPSHOT,
      citationStatus: "verified",
      flow: {
        trees: [
          {
            kind: "control_flow",
            title: "Cleanup",
            nodes: [
              {
                label: "drop ```legacy``` path",
                change: "removed",
                citations: [
                  hunk("h3", "src/legacy.ts", "@@ -1,5 +0,0 @@"),
                  // A 0.1.3 description citation and a hunk with no path name no location.
                  { alias: "d1", kind: "description", label: "Paragraph 1" },
                  { alias: "h4", kind: "hunk", label: "@@ -2,1 +2,2 @@" },
                ],
                children: [],
              },
            ],
          },
          {
            kind: "contract",
            title: "Token",
            nodes: [
              {
                label: "export type Token",
                change: "unchanged",
                citations: [hunk("h5", "src/token.ts", "@@ -3,2 +3,3 @@ type")],
                children: [
                  {
                    label: "expiresAt: number",
                    change: "added",
                    citations: [hunk("h5", "src/token.ts", "@@ -3,2 +3,3 @@")],
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
      reach: {
        symbols: [
          {
            name: "Token",
            outsideCallerFiles: 2,
            outsidePaths: ["src/a.ts", "src/b.ts"],
            insidePR: true,
            status: "changed",
          },
          {
            name: "fresh",
            outsideCallerFiles: 0,
            outsidePaths: [],
            insidePR: false,
            status: "new",
          },
        ],
        surfaces: [],
        untested: [{ path: "src/token.ts", reason: "no_test_in_pr" }],
        removedStillReferenced: [{ name: "legacy", paths: ["src/app.ts"] }],
        method: "text_match",
        hop: 1,
      },
    };

    expect(renderBriefAsPullRequestDescription(brief)).toBe(
      [
        "## Flow",
        "",
        "### Control flow: Cleanup",
        "",
        "````diff",
        "- drop ```legacy``` path  (src/legacy.ts)",
        "````",
        "",
        "### Contract: Token",
        "",
        "```diff",
        "  export type Token  (src/token.ts:3)",
        "+ └── expiresAt: number",
        "```",
        "",
        "## Blast radius",
        "",
        "Text match, one hop out.",
        "",
        "- `Token` is named in 2 files outside this change",
        "- Removed `legacy` is still named in `src/app.ts`",
        "- No changed test mentions `src/token.ts`",
        "",
      ].join("\n"),
    );
  });

  it("keeps a Flow title with line breaks on its heading line", () => {
    const brief: NormalizedBrief = {
      snapshot: SNAPSHOT,
      citationStatus: "verified",
      flow: {
        trees: [
          {
            kind: "call_tree",
            title: "Recovery\n\nwrites",
            nodes: [
              {
                label: "recover()",
                change: "added",
                citations: [],
                children: [],
              },
            ],
          },
        ],
      },
    };

    expect(renderBriefAsPullRequestDescription(brief)).toContain(
      "### Call tree: Recovery writes\n\n```diff",
    );
  });
});
