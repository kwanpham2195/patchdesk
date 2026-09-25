import { describe, expect, it } from "vitest";

import {
  analysisRanAgainstChangeIntent,
  parseChangeIntent,
  type ChangeIntent,
} from "../../src/domain/change-intent";
import {
  createReviewSessionId,
  parseContentHash,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseIsoTimestamp,
  parseLocalBranchName,
  parsePullRequestNumber,
  parseRepoRelativePath,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";
import {
  createReview,
  moveLocalReviewToSession,
  parseReview,
  serializeReview,
  setChangeIntent,
} from "../../src/domain/review";

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("Invalid fixture");
  return result.value;
}

const repository = {
  profileId: must(parseWorkspaceProfileId("acme")),
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("octo-org")),
  repo: must(parseGitHubRepoName("patchdesk")),
};
const headSha = must(parseGitSha("1".repeat(40)));
const baseSha = must(parseGitSha("b".repeat(40)));
const createdAt = must(parseIsoTimestamp("2026-09-26T00:00:00.000Z"));
const setAt = must(parseIsoTimestamp("2026-09-26T00:01:00.000Z"));
const localIdentity = {
  ...repository,
  source: {
    kind: "working_tree" as const,
    branch: must(parseLocalBranchName("main")),
  },
};
const sessionId = createReviewSessionId({ ...localIdentity, headSha, baseSha });

function localReview() {
  return createReview({
    identity: localIdentity,
    currentSessionId: sessionId,
    headSha,
    createdAt,
  });
}

const textIntent: ChangeIntent = {
  kind: "text",
  markdown: "Add a guard to recovery.",
};
const fileIntent: ChangeIntent = {
  kind: "file",
  path: must(parseRepoRelativePath("docs/spec.md")),
};

describe("Change intent on a Review", () => {
  it.each([
    ["text", textIntent],
    ["a spec file", fileIntent],
  ])(
    "keeps a local Review's %s intent through its stored form",
    (_case, intent) => {
      const review = must(setChangeIntent(localReview(), intent, setAt));

      expect(
        parseReview(structuredClone(serializeReview(review))),
      ).toMatchObject({ _tag: "ok", value: { changeIntent: intent } });
    },
  );

  it("keeps the intent when the Review moves to a new session", () => {
    const review = must(setChangeIntent(localReview(), textIntent, setAt));
    const moved = must(
      moveLocalReviewToSession(review, {
        sessionId: createReviewSessionId({
          ...localIdentity,
          headSha: must(parseGitSha("2".repeat(40))),
          baseSha,
        }),
        headSha: must(parseGitSha("2".repeat(40))),
        updatedAt: setAt,
      }),
    );

    expect(moved.changeIntent).toEqual(textIntent);
  });

  it("refuses a stored pull request Review that holds an intent", () => {
    const pullRequest = createReview({
      identity: {
        ...repository,
        source: {
          kind: "pull_request",
          prNumber: must(parsePullRequestNumber(42)),
        },
      },
      currentSessionId: sessionId,
      headSha,
      createdAt,
    });

    expect(
      parseReview({
        ...serializeReview(pullRequest),
        changeIntent: textIntent,
      }),
    ).toEqual({ _tag: "err", error: { _tag: "InvalidReview" } });
  });

  it("accepts text of exactly 65,536 bytes", () => {
    expect(
      parseChangeIntent({ kind: "text", markdown: "a".repeat(65_536) }),
    ).toMatchObject({ _tag: "ok" });
  });

  it.each([
    ["whitespace-only text", { kind: "text", markdown: " \n\t" }],
    // 32,769 two-byte characters: under the bound in characters, over it in bytes.
    ["text over 65,536 bytes", { kind: "text", markdown: "é".repeat(32_769) }],
    ["an absolute path", { kind: "file", path: "/etc/passwd" }],
    ["a path that leaves the repository", { kind: "file", path: "../spec.md" }],
    ["an empty path", { kind: "file", path: "" }],
  ] as const)("refuses %s", (_case, raw) => {
    expect(parseChangeIntent(raw)).toEqual({
      _tag: "err",
      error: { _tag: "InvalidChangeIntent" },
    });
  });
});

describe("analysisRanAgainstChangeIntent", () => {
  const digest = (character: string) =>
    must(parseContentHash(character.repeat(64)));
  const specPath = must(parseRepoRelativePath("docs/spec.md"));

  it.each([
    ["current with no intent then and now", undefined, undefined, true],
    [
      "current with the same text",
      { kind: "text", sha256: digest("a") },
      { kind: "text", sha256: digest("a") },
      true,
    ],
    [
      "outdated after the text is edited",
      { kind: "text", sha256: digest("a") },
      { kind: "text", sha256: digest("b") },
      false,
    ],
    [
      "current with the same spec file, whatever its bytes were",
      { kind: "file", path: specPath, sha256: digest("a") },
      { kind: "file", path: specPath },
      true,
    ],
    [
      "outdated after text is replaced by a spec file",
      { kind: "text", sha256: digest("a") },
      { kind: "file", path: specPath },
      false,
    ],
    [
      "outdated after an intent is set",
      undefined,
      { kind: "file", path: specPath },
      false,
    ],
    [
      "outdated after the intent is cleared",
      { kind: "text", sha256: digest("a") },
      undefined,
      false,
    ],
  ] as const)("is %s", (_case, ran, current, expected) => {
    expect(analysisRanAgainstChangeIntent(ran, current)).toBe(expected);
  });
});
