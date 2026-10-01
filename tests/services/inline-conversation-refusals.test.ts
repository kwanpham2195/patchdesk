import { describe, expect, it, vi } from "vitest";

import {
  InlineConversationService,
  type DirectConversationCommand,
} from "../../src/services/inline-conversation-service";
import {
  parseGitHubHost,
  parseGitHubOwner,
  parseGitHubRepoName,
  parseGitSha,
  parsePullRequestNumber,
  parseReviewId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { err, ok, type Result } from "../../src/domain/result";
import type { ReviewWriteOperation } from "../../src/domain/review-write-operation";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import { confirmedWriteJournal } from "./write-invariant-harness";

/** Refused conversation writes (issue #755): which refusals are final and which wait for a landed check. */
const must = <T>(result: Result<T, unknown>): T => {
  if (result._tag === "ok") return result.value;
  throw new Error("fixture");
};
const profileId = must(parseWorkspaceProfileId("acme"));
const reviewId = must(
  parseReviewId("acme__octo-org__patchdesk__pr-42__review-abcdef123456"),
);
const headSha = must(parseGitSha("1".repeat(40)));
const sessionKey = {
  profileId,
  host: must(parseGitHubHost("github.com")),
  owner: must(parseGitHubOwner("octo-org")),
  repo: must(parseGitHubRepoName("patchdesk")),
  source: {
    kind: "pull_request" as const,
    prNumber: must(parsePullRequestNumber(42)),
  },
  headSha,
};

/** Minimal fresh gate: every command passes freshness against the fixture head. */
const makeGate = () => ({
  requireFresh: vi.fn(async () =>
    // SAFETY: the service only reads `session.key` from this stub; `profile`
    // is forwarded opaquely into the gateway mocks below, which ignore it.
    ok({
      session: { key: sessionKey },
      profile: { ghAccount: "reviewer" },
    } as never),
  ),
});

const expected = { sessionId: "session-a", headSha, patchHash: "patch-hash" };
// SAFETY: this literal is a well-formed ISO 8601 instant, satisfying the
// branded IsoTimestamp contract the service's `now` dependency expects.
const now = () => "2026-01-01T00:00:00.000Z" as never;
const makeRecentWrites = () => confirmedWriteJournal();

function makeOperations() {
  let current: ReviewWriteOperation | undefined;
  return {
    load: vi.fn(async () => ok(current)),
    begin: vi.fn(async (operation: ReviewWriteOperation) => {
      if (current !== undefined)
        return err({ _tag: "ReviewWriteOperationExists" as const });
      current = operation;
      return ok(undefined);
    }),
    markOutcomeUnknown: vi.fn(async (operation: ReviewWriteOperation) => {
      current = operation;
      return ok(undefined);
    }),
    confirm: vi.fn(async (operation: ReviewWriteOperation) => {
      current = operation;
      return ok(undefined);
    }),
    reject: vi.fn(async () => {
      current = undefined;
      return ok(undefined);
    }),
    remove: vi.fn(async () => {
      current = undefined;
      return ok(undefined);
    }),
    current: () => current,
  };
}

function command(
  overrides: Partial<DirectConversationCommand>,
): DirectConversationCommand {
  // SAFETY: `overrides` can switch `_tag` to any DirectConversationCommand
  // variant; each call site only sets the fields that variant requires, and
  // the resulting command is exercised (not just constructed) by the test.
  return {
    _tag: "Reply",
    expected,
    threadId: "PRRT_thread",
    body: "A reply",
    ...overrides,
  } as DirectConversationCommand;
}

function makeGateway(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const github = {
    // SAFETY: only `headSha` is read from this stub by the service's
    // current-head freshness check; the rest of PullRequestSummary is unused.
    getPullRequest: vi.fn(async () => ok({ headSha } as never)),
    getPullRequestComments: vi.fn(async () =>
      ok({ threads: [], complete: true }),
    ),
    getReviewThreadTarget: vi.fn(async () => ok({ found: true })),
    getReviewCommentTarget: vi.fn(async () =>
      ok({ found: true, viewerDidAuthor: true }),
    ),
    createInlineComment: vi.fn(),
    createThreadReply: vi.fn(),
    setReviewThreadState: vi.fn(),
    updateThreadComment: vi.fn(),
    deleteThreadComment: vi.fn(),
    ...overrides,
  };
  return github;
}

describe("InlineConversationService refused writes (issue #755)", () => {
  const refusal = (cause: "unprocessable" | "not_found" | "unsupported") =>
    err({
      _tag: "GitHubWriteFailure" as const,
      category: "refused" as const,
      message: "GitHub refused the request.",
      cause,
    });
  const lockedInput = {
    profileId,
    reviewId,
  };
  const setup = (
    overrides: Record<string, ReturnType<typeof vi.fn>>,
    commandOverrides: Partial<DirectConversationCommand>,
  ) => {
    const operations = makeOperations();
    const github = makeGateway(overrides);
    const service = new InlineConversationService(
      makeGate(),
      // SAFETY: the gateway fixture implements every method this refusal row reaches.
      github as never,
      new ReviewOperationCoordinator(),
      now,
      makeRecentWrites(),
      operations,
    );
    const input = { ...lockedInput, command: command(commandOverrides) };
    return { operations, github, service, input };
  };
  const refusedWith = (cause: "unprocessable" | "not_found" | "unsupported") =>
    ({
      _tag: "err",
      error: { reason: "github_refused", cause },
    }) as const;
  const outcomeUnknown = { _tag: "err", error: "outcome_unknown" } as const;
  const lockedState = {
    _tag: "OutcomeUnknown",
    resolution: "check_required",
  };

  it.each([
    ["create", "createInlineComment"],
    ["reply", "createThreadReply"],
    ["edit", "updateThreadComment"],
  ] as const)(
    "a refused %s is final with no landed-check read and releases the lock",
    async (kind, method) => {
      const write = vi.fn(async () => refusal("unprocessable"));
      const { operations, github, service, input } = setup(
        { [method]: write },
        kind === "create"
          ? {
              _tag: "CreateComment",
              anchor: { path: "src/a.ts", startLine: 3, line: 3, side: "new" },
              body: "note",
            }
          : kind === "reply"
            ? { _tag: "Reply", threadId: "PRRT_thread", body: "note" }
            : { _tag: "EditComment", commentId: "1", body: "edited" },
      );

      await expect(service.execute(input)).resolves.toEqual(
        refusedWith("unprocessable"),
      );
      expect(operations.current()).toBeUndefined();
      expect(operations.reject).toHaveBeenCalledOnce();
      expect(github.getPullRequestComments).not.toHaveBeenCalled();
      // The lock is free: the next write reaches GitHub again.
      await service.execute(input);
      expect(write).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps the lock when a final refusal cannot be recorded", async () => {
    const { operations, service, input } = setup(
      { createThreadReply: vi.fn(async () => refusal("unprocessable")) },
      { _tag: "Reply", threadId: "PRRT_thread", body: "note" },
    );
    operations.reject.mockResolvedValueOnce(
      err({ _tag: "StorageFailure" } as never),
    );

    await expect(service.execute(input)).resolves.toEqual(outcomeUnknown);
    expect(operations.current()?.state).toEqual(lockedState);
  });

  describe("resolve uses the comments read", () => {
    const resolve: Partial<DirectConversationCommand> = {
      _tag: "SetThreadState",
      threadId: "PRRT_thread",
      state: "resolved",
    };
    const comments = (
      state: "open" | "resolved" | "outdated",
      complete = true,
    ) =>
      vi.fn(async () =>
        ok({
          threads: [{ id: "PRRT_thread", state, comments: [] }],
          complete,
        } as never),
      );
    const refusedResolve = () => vi.fn(async () => refusal("not_found"));

    it("is refused and unlocked while the thread is still open", async () => {
      const { operations, service, input } = setup(
        {
          setReviewThreadState: refusedResolve(),
          getPullRequestComments: comments("open"),
        },
        resolve,
      );

      await expect(service.execute(input)).resolves.toEqual(
        refusedWith("not_found"),
      );
      expect(operations.current()).toBeUndefined();
    });

    it("stays outcome unknown when the read shows the thread resolved", async () => {
      const { operations, service, input } = setup(
        {
          setReviewThreadState: refusedResolve(),
          getPullRequestComments: comments("resolved"),
        },
        resolve,
      );

      await expect(service.execute(input)).resolves.toEqual(outcomeUnknown);
      expect(operations.current()?.state).toEqual(lockedState);
    });

    it("stays outcome unknown when the comments read is incomplete", async () => {
      const { operations, service, input } = setup(
        {
          setReviewThreadState: refusedResolve(),
          getPullRequestComments: comments("open", false),
        },
        resolve,
      );

      await expect(service.execute(input)).resolves.toEqual(outcomeUnknown);
      expect(operations.current()?.state).toEqual(lockedState);
    });

    it("stays outcome unknown when the comments read fails", async () => {
      const { operations, service, input } = setup(
        {
          setReviewThreadState: refusedResolve(),
          getPullRequestComments: vi.fn(async () =>
            err({ _tag: "GitHubReadFailed" } as never),
          ),
        },
        resolve,
      );

      await expect(service.execute(input)).resolves.toEqual(outcomeUnknown);
      expect(operations.current()?.state).toEqual(lockedState);
    });

    it("stays outcome unknown for an Unresolve when the thread reads outdated", async () => {
      const { operations, service, input } = setup(
        {
          setReviewThreadState: refusedResolve(),
          getPullRequestComments: comments("outdated"),
        },
        { ...resolve, state: "open" },
      );

      await expect(service.execute(input)).resolves.toEqual(outcomeUnknown);
      expect(operations.current()?.state).toEqual(lockedState);
    });

    it("stays outcome unknown when the thread is missing from a complete read", async () => {
      const { operations, service, input } = setup(
        {
          setReviewThreadState: refusedResolve(),
          getPullRequestComments: vi.fn(async () =>
            ok({ threads: [], complete: true } as never),
          ),
        },
        resolve,
      );

      await expect(service.execute(input)).resolves.toEqual(outcomeUnknown);
      expect(operations.current()?.state).toEqual(lockedState);
    });

    it("is final for an unsupported endpoint with no read", async () => {
      const read = comments("resolved");
      const { operations, service, input } = setup(
        {
          setReviewThreadState: vi.fn(async () => refusal("unsupported")),
          getPullRequestComments: read,
        },
        resolve,
      );

      await expect(service.execute(input)).resolves.toEqual(
        refusedWith("unsupported"),
      );
      expect(read).not.toHaveBeenCalled();
      expect(operations.current()).toBeUndefined();
    });
  });

  describe("delete uses the comment target read", () => {
    const remove: Partial<DirectConversationCommand> = {
      _tag: "DeleteComment",
      commentId: "1",
      confirmation: true,
    };
    const target = (
      answers: ReadonlyArray<
        | { readonly found: boolean; readonly viewerDidAuthor?: boolean }
        | "failure"
      >,
    ) => {
      const queue = [...answers];
      return vi.fn(async () => {
        const next = queue.shift() ?? answers[answers.length - 1];
        return next === "failure"
          ? err({ _tag: "GitHubReadFailed" } as never)
          : ok(next as never);
      });
    };
    const refusedDelete = () => vi.fn(async () => refusal("not_found"));

    it("is refused and unlocked while the comment still exists", async () => {
      const { operations, service, input } = setup(
        {
          deleteThreadComment: refusedDelete(),
          getReviewCommentTarget: target([
            { found: true, viewerDidAuthor: true },
          ]),
        },
        remove,
      );

      await expect(service.execute(input)).resolves.toEqual(
        refusedWith("not_found"),
      );
      expect(operations.current()).toBeUndefined();
    });

    it("stays outcome unknown when the comment is gone after the refusal", async () => {
      const { operations, service, input } = setup(
        {
          deleteThreadComment: refusedDelete(),
          getReviewCommentTarget: target([
            { found: true, viewerDidAuthor: true },
            { found: false },
          ]),
        },
        remove,
      );

      await expect(service.execute(input)).resolves.toEqual(outcomeUnknown);
      expect(operations.current()?.state).toEqual(lockedState);
    });

    it("stays outcome unknown when the read after the refusal fails", async () => {
      const { operations, service, input } = setup(
        {
          deleteThreadComment: refusedDelete(),
          getReviewCommentTarget: target([
            { found: true, viewerDidAuthor: true },
            "failure",
          ]),
        },
        remove,
      );

      await expect(service.execute(input)).resolves.toEqual(outcomeUnknown);
      expect(operations.current()?.state).toEqual(lockedState);
    });
  });
});
