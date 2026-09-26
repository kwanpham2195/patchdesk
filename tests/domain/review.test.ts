import { describe, expect, it } from "vitest";

import { definedProps } from "../../src/domain/defined-props";
import {
  createReview,
  markReviewLeft,
  markReviewOpened,
  markReviewRevisionChanged,
  markReviewUnavailable,
  markReviewTerminal,
  moveReviewToSession,
  parseReview,
  serializeReview,
  sessionRepresentsReview,
  type ReviewIdentity,
} from "../../src/domain/review";
import { reviewSourceTitle } from "../../src/domain/review-source";
import {
  createReviewId,
  createReviewSessionId,
  parseContentHash,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseAbsolutePath,
  parseGitSha,
  parseIsoTimestamp,
  parseLocalBranchName,
  parsePullRequestNumber,
  parseReviewId,
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import type { Result } from "../../src/domain/result";

function must<T>(result: Result<T, unknown>): T {
  if (result._tag === "err") throw new Error("Invalid fixture");
  return result.value;
}

const identity: ReviewIdentity = {
  profileId: must(parseWorkspaceProfileId("acme")),
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("octo-org")),
  repo: must(parseGitHubRepoName("patchdesk")),
  source: { kind: "pull_request", prNumber: must(parsePullRequestNumber(42)) },
};
const firstSha = must(parseGitSha("1".repeat(40)));
const secondSha = must(parseGitSha("2".repeat(40)));
const baseSha = must(parseGitSha("b".repeat(40)));
const otherBaseSha = must(parseGitSha("c".repeat(40)));
const now = must(parseIsoTimestamp("2026-08-01T00:00:00.000Z"));
const later = must(parseIsoTimestamp("2026-08-01T00:01:00.000Z"));
const firstSessionId = createReviewSessionId({
  ...identity,
  headSha: firstSha,
  baseSha,
});
const secondSessionId = createReviewSessionId({
  ...identity,
  headSha: secondSha,
  baseSha,
});
const snapshotHash = must(parseContentHash("a".repeat(64)));

function review() {
  return createReview({
    identity,
    currentSessionId: firstSessionId,
    headSha: firstSha,
    createdAt: now,
  });
}

describe("Review", () => {
  it("builds deterministic IDs that distinguish same-head different-base revisions", () => {
    const first = createReviewSessionId({
      ...identity,
      headSha: firstSha,
      baseSha,
    });
    expect(first).toContain("__base-bbbbbbbb__");
    expect(first).toBe(
      createReviewSessionId({ ...identity, headSha: firstSha, baseSha }),
    );
    expect(first).not.toBe(
      createReviewSessionId({
        ...identity,
        headSha: firstSha,
        baseSha: otherBaseSha,
      }),
    );
  });

  it("keeps pull request IDs byte-identical to the ones stored before local sources", () => {
    expect(createReviewId(identity)).toBe(
      "github.com__octo-org__patchdesk__pr-42__review-96b3842bb75a",
    );
    expect(firstSessionId).toBe(
      "github.com__octo-org__patchdesk__pr-42__sha-11111111__base-bbbbbbbb__e8f65ce3936a",
    );
  });

  it("loads a pull request record stored before local sources and writes it back unchanged", () => {
    const stored = {
      schemaVersion: 2,
      id: "github.com__octo-org__patchdesk__pr-42__review-96b3842bb75a",
      identity: {
        profileId: "acme",
        host: "github.com",
        owner: "octo-org",
        repo: "patchdesk",
        prNumber: 42,
      },
      currentSessionId:
        "github.com__octo-org__patchdesk__pr-42__sha-11111111__base-bbbbbbbb__e8f65ce3936a",
      currentHeadSha: "1".repeat(40),
      freshness: { _tag: "Fresh" },
      status: { _tag: "Open" },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    const parsed = parseReview(stored);
    expect(parsed).toMatchObject({
      _tag: "ok",
      value: { identity: { source: { kind: "pull_request", prNumber: 42 } } },
    });
    if (parsed._tag === "err") throw new Error("fixture");
    expect(serializeReview(parsed.value)).toEqual(stored);
  });

  it("keeps one identity-derived ID across heads", () => {
    expect(createReviewId(identity)).toBe(createReviewId(identity));
    expect(review().id).toBe(createReviewId(identity));
    expect(
      createReview({
        identity,
        currentSessionId: secondSessionId,
        headSha: secondSha,
        createdAt: now,
      }).id,
    ).toBe(review().id);
  });

  it("moves an open review to a new immutable session", () => {
    const moved = moveReviewToSession(review(), {
      sessionId: secondSessionId,
      headSha: secondSha,
      representedRemote: {
        headSha: secondSha,
        pullRequestUpdatedAt: now,
        snapshotHash,
        refreshedAt: later,
      },
      updatedAt: later,
    });

    expect(moved).toMatchObject({
      _tag: "ok",
      value: {
        currentSessionId: secondSessionId,
        currentHeadSha: secondSha,
        representedRemote: { snapshotHash },
        updatedAt: later,
      },
    });
  });

  it("records an open with its title, instant, and advanced updatedAt", () => {
    expect(
      markReviewOpened(review(), { title: "Add the sidebar", now: later }),
    ).toMatchObject({
      title: "Add the sidebar",
      lastOpenedAt: later,
      updatedAt: later,
    });
  });

  it("keeps the recorded title when a later open carries none", () => {
    const titled = markReviewOpened(review(), {
      title: "Add the sidebar",
      now,
    });
    expect(
      markReviewOpened(titled, { title: undefined, now: later }),
    ).toMatchObject({ title: "Add the sidebar", lastOpenedAt: later });
  });

  it("records the head and newest entry seen on leaving, and round-trips them", () => {
    const left = markReviewLeft(review(), {
      headSha: firstSha,
      seenThrough: now,
      now: later,
    });
    expect(left).toMatchObject({
      lastLooked: { headSha: firstSha, seenThrough: now },
      updatedAt: later,
    });
    expect(parseReview(structuredClone(serializeReview(left)))).toEqual({
      _tag: "ok",
      value: left,
    });
  });

  it("never moves seenThrough backwards when a later leave shows nothing newer", () => {
    const left = markReviewLeft(review(), {
      headSha: firstSha,
      seenThrough: later,
      now: later,
    });
    for (const seenThrough of [now, undefined])
      expect(
        markReviewLeft(left, { headSha: secondSha, seenThrough, now: later })
          .lastLooked,
      ).toEqual({ headSha: secondSha, seenThrough: later });
  });

  it("parses a record written before the cursor existed", () => {
    const parsed = parseReview(structuredClone(serializeReview(review())));
    expect(parsed).toMatchObject({ _tag: "ok" });
    expect(parsed._tag === "ok" && "lastLooked" in parsed.value).toBe(false);
  });

  it("rejects identity mismatches in stored data", () => {
    expect(
      parseReview({
        ...serializeReview(review()),
        identity: {
          ...serializeReview(review()).identity,
          owner: "other-owner",
        },
      }),
    ).toMatchObject({ _tag: "err" });
  });

  it("keeps terminal reviews immutable", () => {
    const terminal = markReviewTerminal(review(), "merged", later);
    expect(markReviewTerminal(terminal, "closed", later)).toEqual(terminal);
    expect(
      moveReviewToSession(terminal, {
        sessionId: secondSessionId,
        headSha: secondSha,
        representedRemote: {
          headSha: secondSha,
          pullRequestUpdatedAt: later,
          snapshotHash,
          refreshedAt: later,
        },
        updatedAt: later,
      }),
    ).toMatchObject({ _tag: "err", error: { _tag: "ReviewTerminal" } });
    expect(
      markReviewUnavailable(
        terminal,
        { detectedAt: later, reason: "github_read" },
        later,
      ),
    ).toEqual(terminal);
  });

  it("records a complete changed revision without replacing represented state", () => {
    const updated = markReviewRevisionChanged(
      review(),
      {
        detectedAt: later,
        identity: {
          headSha: secondSha,
          baseSha,
          canonicalPatchHash: snapshotHash,
        },
      },
      later,
    );
    expect(updated).toMatchObject({
      freshness: {
        _tag: "RevisionChanged",
        detectedAt: later,
        identity: {
          headSha: secondSha,
          baseSha,
          canonicalPatchHash: snapshotHash,
        },
      },
      currentSessionId: firstSessionId,
      currentHeadSha: firstSha,
      updatedAt: later,
    });
  });

  it("rejects legacy detection records that lack a canonical revision identity", () => {
    const { freshness: _freshness, ...legacyFields } =
      serializeReview(review());
    void _freshness;
    const legacy = {
      ...legacyFields,
      schemaVersion: 1,
      detectedUpdate: { detectedAt: later, reason: "checks" },
    };
    const parsed = parseReview(legacy);
    expect(parsed).toMatchObject({ _tag: "err" });
  });

  it("parses only complete revision-change evidence", () => {
    const invalid = {
      ...serializeReview(review()),
      freshness: {
        _tag: "RevisionChanged",
        detectedAt: later,
        identity: { headSha: secondSha, baseSha },
      },
    };
    expect(parseReview(invalid)).toMatchObject({ _tag: "err" });
  });
});

describe("sessionRepresentsReview", () => {
  const key = { ...identity, headSha: firstSha, baseSha };

  it("accepts the session key the Review currently points at", () => {
    expect(sessionRepresentsReview(review(), { key })).toBe(true);
  });

  it("rejects a mismatch in any one of the six compared fields", () => {
    const mismatches = [
      { profileId: must(parseWorkspaceProfileId("other")) },
      { host: must(parseGitHubHost("github.example.com")) },
      { owner: must(parseGitHubOwner("someone-else")) },
      { repo: must(parseGitHubRepoName("other-repo")) },
      {
        source: {
          kind: "pull_request" as const,
          prNumber: must(parsePullRequestNumber(43)),
        },
      },
      { headSha: secondSha },
    ];
    for (const mismatch of mismatches)
      expect(
        sessionRepresentsReview(review(), { key: { ...key, ...mismatch } }),
      ).toBe(false);
  });

  it("ignores the base SHA, which is session identity rather than revision", () => {
    expect(
      sessionRepresentsReview(review(), {
        key: { ...key, baseSha: otherBaseSha },
      }),
    ).toBe(true);
  });
});

describe("local Review source IDs", () => {
  const repository = {
    profileId: identity.profileId,
    host: identity.host,
    owner: identity.owner,
    repo: identity.repo,
  };
  function branchIdentity(branch: string): ReviewIdentity {
    return {
      ...repository,
      source: {
        kind: "branch",
        branch: must(parseLocalBranchName(branch)),
        baseBranch: must(parseLocalBranchName("main")),
      },
    };
  }

  it("names a branch with a slash in a readable segment that both ID parsers accept", () => {
    const branch = branchIdentity("feat/login");
    const reviewId = createReviewId(branch);
    const sessionId = createReviewSessionId({
      ...branch,
      headSha: firstSha,
      baseSha,
    });

    expect(reviewId).toMatch(
      /^github\.com__octo-org__patchdesk__local-branch-feat-login__review-[a-f0-9]{12}$/,
    );
    expect(sessionId).toContain("__local-branch-feat-login__sha-11111111__");
    expect(parseReviewId(reviewId)).toEqual({ _tag: "ok", value: reviewId });
    expect(parseReviewSessionId(sessionId)).toEqual({
      _tag: "ok",
      value: sessionId,
    });
  });

  it.each<[string, ReviewIdentity, ReviewIdentity]>([
    [
      "two branches that sanitize to the same slug",
      branchIdentity("feat/login"),
      branchIdentity("feat-login"),
    ],
    [
      "a detached working tree and a branch literally named detached",
      { ...repository, source: { kind: "working_tree" } },
      {
        ...repository,
        source: {
          kind: "working_tree",
          branch: must(parseLocalBranchName("detached")),
        },
      },
    ],
  ])("gives %s different IDs", (_case, left, right) => {
    expect(createReviewId(left)).not.toBe(createReviewId(right));
    expect(
      createReviewSessionId({ ...left, headSha: firstSha, baseSha }),
    ).not.toBe(createReviewSessionId({ ...right, headSha: firstSha, baseSha }));
  });

  function workingTreeIn(checkout?: string): ReviewIdentity {
    return {
      ...repository,
      source: {
        kind: "working_tree",
        branch: must(parseLocalBranchName("main")),
        ...definedProps({
          checkout:
            checkout === undefined
              ? undefined
              : must(parseAbsolutePath(checkout)),
        }),
      },
    };
  }

  it("keeps configured-checkout IDs byte-identical to the ones stored before named checkouts", () => {
    const configured = workingTreeIn();

    expect(createReviewId(configured)).toBe(
      "github.com__octo-org__patchdesk__local-working_tree-main__review-a5d7d4d5e9b4",
    );
    expect(
      createReviewSessionId({ ...configured, headSha: firstSha, baseSha }),
    ).toBe(
      "github.com__octo-org__patchdesk__local-working_tree-main__sha-11111111__base-bbbbbbbb__e6ad30fb2efd",
    );
  });

  it("gives each checkout of one branch its own Review and session IDs", () => {
    const ids = ["/work/patchdesk", "/work/linked", "/other/linked"].map(
      (checkout) => ({
        review: createReviewId(workingTreeIn(checkout)),
        session: createReviewSessionId({
          ...workingTreeIn(checkout),
          headSha: firstSha,
          baseSha,
        }),
      }),
    );

    expect(ids[1]?.review).toMatch(
      /^github\.com__octo-org__patchdesk__local-working_tree-linked--main__review-[a-f0-9]{12}$/,
    );
    expect(parseReviewId(ids[1]?.review)._tag).toBe("ok");
    expect(parseReviewSessionId(ids[1]?.session)._tag).toBe("ok");
    expect(new Set(ids.map((id) => id.review)).size).toBe(3);
    expect(new Set(ids.map((id) => id.session)).size).toBe(3);
    expect(ids.map((id) => id.review)).not.toContain(
      createReviewId(workingTreeIn()),
    );
  });

  it("round-trips a stored local Review with its source", () => {
    const local = createReview({
      identity: branchIdentity("feat/login"),
      currentSessionId: createReviewSessionId({
        ...branchIdentity("feat/login"),
        headSha: firstSha,
        baseSha,
      }),
      headSha: firstSha,
      createdAt: now,
    });
    const stored = structuredClone(serializeReview(local));

    expect(stored.identity).toEqual({
      ...repository,
      source: { kind: "branch", branch: "feat/login", baseBranch: "main" },
    });
    expect(parseReview(stored)).toEqual({ _tag: "ok", value: local });
  });

  it("stores a named checkout with its source and refuses a relative one", () => {
    const linked = createReview({
      identity: workingTreeIn("/work/linked"),
      currentSessionId: createReviewSessionId({
        ...workingTreeIn("/work/linked"),
        headSha: firstSha,
        baseSha,
      }),
      headSha: firstSha,
      createdAt: now,
    });
    const stored = structuredClone(serializeReview(linked));

    expect(parseReview(stored)).toEqual({ _tag: "ok", value: linked });
    expect(
      parseReview({
        ...stored,
        identity: {
          ...stored.identity,
          source: { kind: "working_tree", branch: "main", checkout: "linked" },
        },
      })._tag,
    ).toBe("err");
  });

  it("caps a long checkout folder in the readable ID and keeps two such folders apart by the hash", () => {
    const folder = "a-very-long-worktree-folder-name-for-an-agent";
    const left = createReviewId(workingTreeIn(`/work/${folder}-one`));
    const right = createReviewId(workingTreeIn(`/work/${folder}-two`));

    expect(left).toContain(`local-working_tree-${folder.slice(0, 24)}--main__`);
    expect(parseReviewId(left)._tag).toBe("ok");
    expect(left).not.toBe(right);
  });

  it("names a checkout's folder in the title of a Review read from it", () => {
    const configured = reviewSourceTitle(workingTreeIn().source);
    const linked = reviewSourceTitle(workingTreeIn("/work/linked").source);

    expect(linked).not.toBe(configured);
    expect(linked.startsWith(configured)).toBe(true);
    expect(linked.endsWith("linked")).toBe(true);
  });
});
