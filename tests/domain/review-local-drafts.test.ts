import { describe, expect, it } from "vitest";

import {
  createReviewSessionId,
  parseFindingId,
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parseInsightRunId,
  parseIsoTimestamp,
  parseLocalBranchName,
  parseLocalNoteId,
  parsePullRequestNumber,
  parseRepoRelativePath,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import type {
  FindingDraft,
  LocalDraft,
  MaintainerNote,
} from "../../src/domain/local-draft";
import type { Result } from "../../src/domain/result";
import {
  addLocalDraft,
  createReview,
  editMaintainerNote,
  parseReview,
  removeLocalDraft,
  serializeReview,
  type Review,
  type ReviewIdentity,
} from "../../src/domain/review";
import type { LocalReviewSource } from "../../src/domain/review-source";

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
const createdAt = must(parseIsoTimestamp("2026-09-25T00:00:00.000Z"));
const addedAt = must(parseIsoTimestamp("2026-09-25T00:01:00.000Z"));
const removedAt = must(parseIsoTimestamp("2026-09-25T00:02:00.000Z"));
const runId = must(parseInsightRunId("insight-analysis-1-aaaaaaaaaaaa-run"));

const localIdentity: ReviewIdentity<LocalReviewSource> = {
  ...repository,
  source: {
    kind: "working_tree",
    branch: must(parseLocalBranchName("main")),
  },
};

function localReview(): Review<LocalReviewSource> {
  return createReview({
    identity: localIdentity,
    currentSessionId: createReviewSessionId({
      ...localIdentity,
      headSha,
      baseSha,
    }),
    headSha,
    createdAt,
  });
}

function draft(findingId: string): FindingDraft {
  return {
    findingId: must(parseFindingId(findingId)),
    analysisRunId: runId,
    sessionId: localReview().currentSessionId,
    anchor: {
      path: must(parseRepoRelativePath("src/sum.ts")),
      side: "new",
      startLine: 3,
      line: 3,
      selectedLines: ["  for (let i = 0; i <= n; i += 1) {"],
      before: ["export function sum(n: number) {", "  let total = 0;"],
      after: ["    total += i;", "  }"],
    },
    title: "Off-by-one bound",
    comment: "The loop reads one element past the end.",
    suggestion: { code: "  for (let i = 0; i < n; i += 1) {" },
    addedAt,
  };
}

const noteId = must(parseLocalNoteId("note-1"));

function note(text: string): MaintainerNote {
  return {
    author: "maintainer",
    noteId,
    sessionId: localReview().currentSessionId,
    anchor: {
      path: must(parseRepoRelativePath("src/sum.ts")),
      side: "new",
      startLine: 2,
      line: 3,
      selectedLines: [
        "  let total = 0;",
        "  for (let i = 0; i <= n; i += 1) {",
      ],
      before: ["export function sum(n: number) {"],
      after: ["    total += i;", "  }"],
    },
    text,
    createdAt: addedAt,
    updatedAt: addedAt,
  };
}

function added(review: Review<LocalReviewSource>, entry: LocalDraft) {
  return must(addLocalDraft(review, entry));
}

describe("Local drafts on a Review", () => {
  it("keeps one draft per Finding when the same Finding is added twice", () => {
    const once = added(localReview(), draft("finding-bound"));
    const twice = added(once, draft("finding-bound"));

    expect(twice.localDrafts).toHaveLength(1);
    expect(twice).toBe(once);
    expect(Date.parse(once.updatedAt)).toBeGreaterThan(
      Date.parse(localReview().updatedAt),
    );
  });

  it("removes one draft and stores no list once the last one is gone", () => {
    const both = added(
      added(localReview(), draft("finding-bound")),
      draft("finding-name"),
    );
    const one = must(
      removeLocalDraft(
        both,
        { runId, findingId: must(parseFindingId("finding-bound")) },
        removedAt,
      ),
    );
    const none = must(
      removeLocalDraft(
        one,
        { runId, findingId: must(parseFindingId("finding-name")) },
        removedAt,
      ),
    );

    expect(one.localDrafts).toEqual([draft("finding-name")]);
    expect(none).not.toHaveProperty("localDrafts");
    expect(serializeReview(none)).not.toHaveProperty("localDrafts");
  });

  it("changes nothing when the removed draft is not listed", () => {
    const review = added(localReview(), draft("finding-bound"));
    const other = must(
      parseInsightRunId("insight-analysis-2-bbbbbbbbbbbb-run"),
    );

    expect(
      must(
        removeLocalDraft(
          review,
          { runId: other, findingId: must(parseFindingId("finding-bound")) },
          removedAt,
        ),
      ),
    ).toBe(review);
  });

  it("edits a maintainer note's text and keeps the Finding draft beside it unchanged", () => {
    const review = added(
      added(localReview(), draft("finding-bound")),
      note("Name this total."),
    );

    const edited = must(
      editMaintainerNote(review, {
        noteId,
        text: "Rename total to sum.",
        updatedAt: removedAt,
      }),
    );

    expect(edited.localDrafts).toEqual([
      draft("finding-bound"),
      { ...note("Rename total to sum."), updatedAt: edited.updatedAt },
    ]);
    expect(Date.parse(edited.updatedAt)).toBeGreaterThan(
      Date.parse(review.updatedAt),
    );
    expect(
      editMaintainerNote(edited, {
        noteId: must(parseLocalNoteId("note-gone")),
        text: "Anything",
        updatedAt: removedAt,
      }),
    ).toEqual({ _tag: "err", error: { _tag: "NoteNotFound" } });
  });

  it("removes a maintainer note by its id", () => {
    const review = added(
      added(localReview(), draft("finding-bound")),
      note("Name this total."),
    );

    const removed = must(removeLocalDraft(review, { noteId }, removedAt));

    expect(removed.localDrafts).toEqual([draft("finding-bound")]);
  });

  it("round-trips a local Review's Finding draft and maintainer note, with their carry and applied marks, through its stored form", () => {
    const sessionId = localReview().currentSessionId;
    const review = added(
      added(localReview(), {
        ...draft("finding-bound"),
        appliedAt: removedAt,
        carry: { state: "changed", sessionId, notedLines: [] },
      }),
      {
        ...note("Name this total."),
        carry: { state: "needs_attention", sessionId, notedLines: [] },
      },
    );
    const stored = structuredClone(serializeReview(review));

    expect(parseReview(stored)).toEqual({ _tag: "ok", value: review });
  });

  const stored = structuredClone(
    serializeReview(added(localReview(), draft("finding-bound"))),
  );
  const [entry] = stored.localDrafts ?? [];
  if (entry === undefined) throw new Error("fixture");

  it.each([
    ["an unknown field on a draft", { ...entry, note: "extra" }],
    [
      "an anchor whose range runs backwards",
      { ...entry, anchor: { ...entry.anchor, startLine: 4, line: 3 } },
    ],
    ["an empty suggestion", { ...entry, suggestion: { code: "" } }],
    [
      "an unknown carry state",
      { ...entry, carry: { state: "moved", sessionId: entry.sessionId } },
    ],
    [
      "a Finding draft marked as a maintainer's",
      { ...entry, author: "maintainer" },
    ],
    ["a note with blank text", { ...structuredClone(note("  \n ")) }],
    [
      "a note with an unknown field",
      { ...structuredClone(note("Keep")), title: "Extra" },
    ],
    [
      "a note without its id",
      (({ noteId: _id, ...rest }) => rest)(structuredClone(note("Keep"))),
    ],
  ])("refuses a stored Review with %s", (_case, corrupt) => {
    expect(parseReview({ ...stored, localDrafts: [corrupt] })).toEqual({
      _tag: "err",
      error: { _tag: "InvalidReview" },
    });
  });

  it("refuses an empty stored list, which is stored as no list", () => {
    expect(
      parseReview({ ...serializeReview(localReview()), localDrafts: [] }),
    ).toEqual({ _tag: "err", error: { _tag: "InvalidReview" } });
  });

  it("refuses drafts on a pull request Review, whose stored form stays flat", () => {
    const pullRequest = createReview({
      identity: {
        ...repository,
        source: {
          kind: "pull_request",
          prNumber: must(parsePullRequestNumber(42)),
        },
      },
      currentSessionId: localReview().currentSessionId,
      headSha,
      createdAt,
    });
    const stored = structuredClone(serializeReview(pullRequest));

    expect(Object.keys(stored).sort()).toEqual(
      [
        "createdAt",
        "currentHeadSha",
        "currentSessionId",
        "freshness",
        "id",
        "identity",
        "schemaVersion",
        "status",
        "updatedAt",
      ].sort(),
    );
    expect(
      parseReview({
        ...stored,
        localDrafts: serializeReview(
          added(localReview(), draft("finding-bound")),
        ).localDrafts,
      }),
    ).toEqual({ _tag: "err", error: { _tag: "InvalidReview" } });
  });
});
