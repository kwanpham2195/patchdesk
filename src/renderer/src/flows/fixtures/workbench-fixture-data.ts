import type { WorkbenchResponse } from "../../renderer-contracts";

/** A `conversation.inline.threads` entry, as the Threads navigator section
 * consumes it -- seeded per fixture so the browser suite can exercise the
 * Threads section against real thread data without inventing a new model
 * shape. */
type FixtureConversationThread = NonNullable<
  WorkbenchResponse["conversation"]["inline"]
>["threads"][number];
const noConversationThreads: ReadonlyArray<FixtureConversationThread> = [];

function buildFixturePatch(): string {
  const changedLines = Array.from(
    { length: 48 },
    (_, index) => `-old-${index + 1}\n+new-${index + 1}`,
  ).join("\n");
  return `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,48 +1,48 @@
${changedLines}
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-old
+new
`;
}
function buildActiveFollowPatch(): string {
  return Array.from({ length: 3 }, (_, fileIndex) => {
    const path = `src/${String.fromCharCode(97 + fileIndex)}.ts`;
    const lines = Array.from(
      { length: 48 },
      (_, lineIndex) =>
        `-old-${fileIndex}-${lineIndex}\n+new-${fileIndex}-${lineIndex}`,
    ).join("\n");
    return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,48 +1,48 @@\n${lines}\n`;
  }).join("");
}

export const fixturePatch = buildFixturePatch();
export const walkthroughFixturePatch = `${fixturePatch}diff --git a/src/c.ts b/src/c.ts\n--- a/src/c.ts\n+++ b/src/c.ts\n@@ -1 +1 @@\n-old\n+new\n`;
const activeFollowFixturePatch = buildActiveFollowPatch();

// A Conversation timeline long enough that its tab genuinely scrolls past
// the viewport -- `#workbench-fixture`'s own conversation is empty ("No
// conversation yet."), which can't exercise "the rail stays in view while
// the timeline scrolls" (nothing to scroll). Twenty multi-sentence issue
// comments comfortably exceed any realistic test viewport height.
export const longConversationFixtureEntries: WorkbenchResponse["conversation"]["entries"] =
  Array.from({ length: 20 }, (_, index) => ({
    _tag: "IssueComment" as const,
    comment: {
      id: `conversation-rail-comment-${index}`,
      author: `reviewer-${index}`,
      body: `Comment ${index}: this fixture body is deliberately long enough, across several sentences, to make the Conversation timeline taller than any realistic browser viewport. It exists only to prove the metadata rail stays pinned in view while this timeline scrolls underneath it.`,
      createdAt: "2026-07-17T00:00:00.000Z",
    },
  }));

export const workbenchFixtureData = {
  fullPatch: fixturePatch,
  pullRequest: {
    ref: {
      host: "github.com",
      owner: "centraldigital",
      repo: "patchdesk",
      number: 42,
    },
    title: "Protect review writes",
    description:
      "## Review path\n\n<details open><summary>Deployment notes</summary><p>Keep this preview readable.</p></details>\n\n```mermaid\ngraph TD\n  A[Open] --> B[Review]\n```",
    author: "fixture",
    headBranch: "feat/review",
    baseBranch: "sit",
    headSha: "abcdef1234567890abcdef1234567890abcdef12",
    isOpen: true,
    isDraft: false,
    reviewState: "none",
    mergeability: "mergeable",
    labels: [
      { name: "bug", color: "d73a4a" },
      { name: "needs-review", color: "0075ca" },
    ],
    assignees: ["fixture-assignee"],
    requestedReviewers: ["fixture-reviewer"],
    updatedAt: "2026-07-17T00:00:00.000Z",
  },
  result: {
    changeSummary: "Review completed for Patchdesk workbench",
    verdict: "comment",
    summary: "One mapped finding and one finding that needs manual placement.",
    findings: [
      {
        id: "mapped",
        severity: "P1",
        title: "Keep writes behind the stale-head check",
        file: "src/b.ts",
        lineStart: 1,
        diffSide: "new",
        explanation:
          "A GitHub adapter must never bypass the current head check.",
        suggestedComment: "Keep the stale-head check at the write boundary.",
        confidence: "high",
        mappingStatus: "mapped",
      },
      {
        id: "unmapped",
        severity: "P2",
        title: "Document the manual placement",
        explanation: "This review point has no verified diff coordinate.",
        confidence: "medium",
        mappingStatus: "unmapped",
      },
    ],
    validationPlan: [
      "pnpm test -- --run review-workbench",
      "pnpm test:e2e -- --grep completed-review",
    ],
    assumptions: [
      "The head SHA remains current while this Review is inspected.",
    ],
  },

  commits: [
    {
      sha: "b".repeat(40),
      message: "Preserve review write coordination",
      author: "fixture",
      authoredAt: "2026-07-17T00:00:00.000Z",
      isHead: true,
    },
    {
      sha: "a".repeat(40),
      message: "Add review workbench",
      author: "fixture",
      authoredAt: "2026-07-16T00:00:00.000Z",
      isHead: false,
    },
  ],
  comments: {
    threads: [
      {
        id: "thread-1",
        state: "open" as const,
        location: { path: "src/b.ts", line: 1 },
        comments: [
          {
            id: "comment-1",
            author: "reviewer",
            body: "Existing GitHub review comment.",
            createdAt: "2026-07-16T00:00:00.000Z",
            url: "https://github.com/centraldigital/patchdesk/pull/1#discussion_r1",
          },
        ],
      },
    ],
  },
  checks: {
    overall: "failing" as const,
    checks: [
      {
        name: "unit",
        required: true as const,
        status: "completed" as const,
        conclusion: "failure" as const,
        url: "https://github.com/centraldigital/patchdesk/actions/runs/1",
      },
      { name: "docs", required: false as const, status: "queued" as const },
    ],
  },
  conversationThreads: noConversationThreads,
};
// Threads placed for the browser suite's Threads-navigator coverage: one new-
// side single line, one old-side single line, one multi-line range, and one
// in src/c.ts -- the third file of `activeFollowFixturePatch`. Every file in
// the patch is handed to the diff at mount, but Pierre's CodeView still
// virtualizes its own rendering, so a file this far down has no header in
// the DOM until something scrolls the viewport near it. Selecting the
// src/c.ts thread must drive that scroll itself, exercising the same
// scroll-to-selection path a deep file-tree jump does (see "Threads section
// selection on a file below the fold scrolls the diff and marks the
// anchored line" in tests/browser/review-workbench.spec.ts).
const activeFollowFixtureConversationThreads: ReadonlyArray<FixtureConversationThread> =
  [
    {
      // Kept in src/a.ts -- the file the diff already shows before any
      // selection -- but deep enough (line 45 of 48) that centering the
      // target row still forces the viewport to scroll away from its
      // initial scrollTop: 0 render, rather than landing on a position
      // close enough to 0 that a real regression could hide behind it.
      id: "thread-new-side",
      state: "open",
      location: { path: "src/a.ts", line: 45, diffSide: "new" },
      comments: [
        {
          id: "comment-new-side",
          author: "new-side-thread-author",
          body: "New-side thread body.",
          createdAt: "2026-07-17T00:00:00.000Z",
        },
      ],
    },
    {
      id: "thread-old-side",
      state: "open",
      location: { path: "src/b.ts", line: 12, diffSide: "old" },
      comments: [
        {
          id: "comment-old-side",
          author: "old-side-thread-author",
          body: "Old-side thread body.",
          createdAt: "2026-07-17T00:00:00.000Z",
        },
      ],
    },
    {
      id: "thread-multiline",
      state: "open",
      location: { path: "src/b.ts", line: 30, lineEnd: 33, diffSide: "new" },
      comments: [
        {
          id: "comment-multiline",
          author: "multiline-thread-author",
          body: "Multi-line thread body.",
          createdAt: "2026-07-17T00:00:00.000Z",
        },
      ],
    },
    {
      id: "thread-deep-file",
      state: "open",
      location: { path: "src/c.ts", line: 30, diffSide: "new" },
      comments: [
        {
          id: "comment-deep-file",
          author: "deep-file-thread-author",
          body: "Deep-file thread body.",
          createdAt: "2026-07-17T00:00:00.000Z",
        },
      ],
    },
  ];
export const activeFollowFixtureData = {
  ...workbenchFixtureData,
  fullPatch: activeFollowFixturePatch,
  conversationThreads: activeFollowFixtureConversationThreads,
};
const longFixturePath =
  "src/features/review-workbench/components/extremely-long-directory-name-without-shortcuts/authoritative-review-write-coordination-and-recovery-surface.ts";
const longFixtureTitle =
  "Protect the authoritative review write boundary when a pull request title contains localized text, identifiers, and enough detail to exceed the available header width";
export const longWorkbenchFixtureData = {
  ...workbenchFixtureData,
  fullPatch: `diff --git a/${longFixturePath} b/${longFixturePath}\n--- a/${longFixturePath}\n+++ b/${longFixturePath}\n@@ -1 +1 @@\n-old\n+new\n`,
  pullRequest: {
    ...workbenchFixtureData.pullRequest,
    ref: {
      ...workbenchFixtureData.pullRequest.ref,
      owner: "centraldigital-platform-engineering-maintainers",
      repo: "patchdesk-desktop-review-workbench-with-a-long-repository-name",
    },
    title: longFixtureTitle,
    author: "reviewer-with-a-long-github-handle-for-layout-validation",
    headBranch:
      "feat/CFW-1234-preserve-authoritative-review-coordination-across-desktop-restarts",
    baseBranch: "release/2026-07-operational-readiness-and-accessibility",
  },
  result: {
    ...workbenchFixtureData.result,
    findings: workbenchFixtureData.result.findings.map((finding, index) =>
      index === 0
        ? {
            ...finding,
            file: longFixturePath,
            title:
              "Keep every pending GitHub write attached to the exact authoritative revision even when the finding title is unusually descriptive",
            explanation:
              "This deliberately long explanation proves that detailed review guidance wraps without making the action rail or navigation pane wider than the viewport.",
          }
        : finding,
    ),
    validationPlan: [
      "pnpm test -- --run tests/services/review-write-controller-with-authoritative-revision-and-recovery.test.ts",
      "pnpm test:e2e -- --grep completed-review-long-localized-content-and-responsive-navigation",
      "authoritativeReviewWriteCoordinationAndRecoverySurfaceWithoutNaturalBreakpointsMustRemainReadableInsideTheInspector",
    ],
  },
  comments: {
    threads: workbenchFixtureData.comments.threads.map((thread) => ({
      ...thread,
      location: { path: longFixturePath, line: 1 },
      comments: thread.comments.map((comment) => ({
        ...comment,
        author: "reviewer-with-a-long-github-handle-for-layout-validation",
        body: "Existing GitHub review comment with enough detail to wrap across several lines while retaining the complete author, timestamp, and discussion content for assistive technology.",
      })),
    })),
  },
  checks: {
    ...workbenchFixtureData.checks,
    checks: workbenchFixtureData.checks.checks.map((check, index) =>
      index === 0
        ? {
            ...check,
            name: "required-review-workbench-authoritative-write-and-restart-recovery-validation",
          }
        : check,
    ),
  },
};

export function canonicalWorkbenchModel(
  data: typeof workbenchFixtureData,
): WorkbenchResponse {
  const headSha = data.pullRequest.headSha;
  const conversation: WorkbenchResponse["conversation"] = {
    prDescription: "",
    entries: [],
  };
  // Built as a separate statement rather than a conditional spread: most
  // fixtures carry no seeded Conversation threads at all, so `inline` is
  // genuinely absent (not present-with-an-empty-array) for them.
  if (data.conversationThreads.length > 0) {
    // A mutable copy: `data.conversationThreads` is deliberately a
    // `ReadonlyArray`, and the contract's `inline.threads` field is plain
    // `Array`, so this spread relaxes variance without a cast.
    const threads = [...data.conversationThreads];
    conversation.inline = { threads };
  }
  // SAFETY: `data.pullRequest` and `data.result` are deliberately typed with
  // widened `string` fields (not `as const`), not narrowed
  // `WorkbenchResponse` literal unions (e.g. `reviewState`, `verdict`,
  // finding `severity`), so `longWorkbenchFixtureData` below can override one
  // finding via `.map()` without TypeScript treating "index 0" and "index 1"
  // as interchangeable branches of a narrowed union. Every fixture literal's
  // actual string values are already valid members of the narrower target
  // enums; only that intentional widening needs bridging here.
  return {
    state: "review",
    viewerLogin: "fixture",
    review: { id: "fixture-review", status: "open" },
    session: {
      id: "fixture-session",
      key: {
        profileId: "fixture",
        host: data.pullRequest.ref.host,
        owner: data.pullRequest.ref.owner,
        repo: data.pullRequest.ref.repo,
        prNumber: data.pullRequest.ref.number,
        headSha,
      },
    },
    revision: {
      reviewedHeadSha: headSha,
      currentHeadSha: headSha,
      freshness: "fresh",
      refreshedAt: "2026-07-17T00:00:00.000Z",
    },
    fullPatch: data.fullPatch,
    pullRequest: data.pullRequest,
    commits: data.commits,
    insights: {
      analysis: {
        status: "current",
        retained: {
          runId: "insight-fixture",
          sessionId: "fixture-session",
          headSha,
          generatedAt: "2026-07-17T00:00:00.000Z",
          value: data.result,
        },
      },
      walkthrough: { status: "not_generated" },
    },
    conversation,
    checks: data.checks,
    mergeReadiness: { _tag: "Ready", blockers: [], warnings: [] },
    mergeReasons: [],
  } as WorkbenchResponse;
}
