import { describe, expect, it } from "vitest";

import type { BriefReach } from "../../src/domain/brief-reach";
import {
  parseContentHash,
  parseGitSha,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";
import { parseStoredBrief } from "../../src/domain/stored-brief";

function value<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("test fixture failed");
  return result.value;
}

const SNAPSHOT = {
  profileId: value(parseWorkspaceProfileId("design")),
  sessionId: value(
    parseReviewSessionId(
      "github.com__octo-org__patchdesk__pr-42__sha-abcdef12__base-12345678__0123456789ab",
    ),
  ),
  headSha: value(parseGitSha("abcdef1234567890abcdef1234567890abcdef12")),
  patchHash: value(parseContentHash("a".repeat(64))),
};

const REACH: BriefReach = {
  symbols: [
    {
      name: "ReviewRefreshService",
      outsideCallerFiles: 1,
      outsidePaths: ["src/main/local-api.ts"],
      insidePR: true,
      status: "changed",
      mentions: [
        {
          path: "src/main/local-api.ts",
          line: 40,
          enclosing: "startLocalApi",
          kind: "call",
        },
        { path: "src/main/local-api.ts", line: 3, kind: "import" },
      ],
      mentionCount: 2,
    },
  ],
  surfaces: [{ surface: "Public API" }],
  untested: [],
  removedStillReferenced: [
    {
      name: "updateComment",
      paths: ["src/main/local-api.ts"],
      mentions: [{ path: "src/main/local-api.ts", line: 9, kind: "call" }],
      mentionCount: 1,
    },
  ],
  method: "text_match",
  hop: 1,
};

describe("parseStoredBrief reach", () => {
  it("keeps every name's mention sites through storage", () => {
    const brief = {
      snapshot: SNAPSHOT,
      citationStatus: "verified",
      reach: REACH,
    };
    expect(parseStoredBrief(structuredClone(brief))).toEqual({
      _tag: "ok",
      value: brief,
    });
  });

  it("reads a Brief stored before mention sites existed without inventing any", () => {
    const legacy = {
      snapshot: SNAPSHOT,
      citationStatus: "verified",
      reach: {
        ...REACH,
        symbols: [
          {
            name: "ReviewRefreshService",
            outsideCallerFiles: 1,
            outsidePaths: ["src/main/local-api.ts"],
            insidePR: true,
            status: "changed",
          },
        ],
        removedStillReferenced: [
          { name: "updateComment", paths: ["src/main/local-api.ts"] },
        ],
      },
    };
    const parsed = parseStoredBrief(structuredClone(legacy));
    if (parsed._tag === "err") throw new Error("expected a Brief");
    expect(
      Object.hasOwn(parsed.value.reach?.symbols[0] ?? {}, "mentions"),
    ).toBe(false);
    expect(parsed.value.reach?.removedStillReferenced).toEqual([
      { name: "updateComment", paths: ["src/main/local-api.ts"] },
    ]);
  });
});
