import { describe, expect, it } from "vitest";

import {
  CommandRunner,
  normalizeCommandLabel,
  type CommandExecution,
  type CommandExecutor,
  type CommandFailure,
  type CommandRequest,
} from "../../src/adapters/github/command-runner";
import type { GitHubServedTransport } from "../../src/adapters/github/gh-request-runner";
import { GitHubAdapter } from "../../src/adapters/github/github-adapter";
import {
  ghInvocationFor,
  type GitHubGraphQlRequest,
  type GitHubRequest,
  type GitHubRestRequest,
} from "../../src/adapters/github/github-request";
import { err, ok, type Result } from "../../src/domain/result";
import type { WorkspaceProfileConfig } from "../../src/domain/workspace-profile";
import { PendingReviewService } from "../../src/services/pending-review-service";
import { ReviewOperationCoordinator } from "../../src/services/review-operation-coordinator";
import { StubCredentials } from "../adapters/stub-github-credentials";
import {
  anchor,
  expected,
  now,
  profileId,
  reviewId,
  reviewNodeId,
  values,
} from "./review-invariant-fixtures";
import {
  freshGate,
  pendingOwner,
  recordingSessions,
  TracingRecentWriteJournal,
  type Trace,
} from "./write-invariant-harness";

/**
 * `write-invariants.test.ts` states "every GitHub write persists intent before
 * the network call" over every flow, but it drives each service through a
 * plain object of gateway methods, so its `write:` entry is the gateway call
 * rather than the transport. That table is unchanged and still the invariant's
 * home.
 *
 * What these two cases add is the seam below it: a real `GitHubAdapter` with
 * writes served over HTTP, where the trace entry is written when the request
 * reaches the transport. One REST write and one mutation, which is what step
 * T3 moved (issue #276).
 */

/** Records the label of every request that reaches the HTTP transport, then fails it. */
class TracingHttpTransport implements GitHubServedTransport {
  constructor(private readonly trace: Trace) {}

  async rest(
    _profile: WorkspaceProfileConfig,
    request: GitHubRestRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    return this.record(request);
  }

  async restText(
    _profile: WorkspaceProfileConfig,
    request: GitHubRestRequest,
  ): Promise<Result<string, CommandFailure>> {
    this.trace.push(`http:${labelOf(request)}`);
    return err({ _tag: "CommandUnavailable" });
  }

  async graphql(
    _profile: WorkspaceProfileConfig,
    request: GitHubGraphQlRequest,
  ): Promise<Result<unknown, CommandFailure>> {
    return this.record(request);
  }

  private record(request: GitHubRequest): Result<unknown, CommandFailure> {
    this.trace.push(`http:${labelOf(request)}`);
    return err({ _tag: "CommandUnavailable" });
  }
}

function labelOf(request: GitHubRequest): string {
  return normalizeCommandLabel(ghInvocationFor(request).argv);
}

/** Any gh child in this suite is a defect: both writes must be served over HTTP. */
class RefusingGhExecutor implements CommandExecutor {
  async execute(_input: CommandRequest): Promise<CommandExecution> {
    return { _tag: "Unavailable" };
  }
}

function pendingReviewOverHttp(trace: Trace) {
  const credentials = new StubCredentials();
  const github = new GitHubAdapter(
    new CommandRunner(new RefusingGhExecutor()),
    credentials,
    new TracingHttpTransport(trace),
  );
  const sessions = recordingSessions(trace, {
    ...values.session,
    pendingReview: pendingOwner(),
  });
  const service = new PendingReviewService(
    // SAFETY: this fixture gate answers with the parsed fixture Review and the
    // store's current session; the service reads no other gate field.
    freshGate(sessions) as never,
    sessions,
    // SAFETY: the real adapter supplies the one write each case performs; the
    // pull request read is the fixture's own, as in `write-invariant-harness`.
    {
      getPullRequest: async () => ok(values.snapshot.pullRequest),
      submitPendingReview: github.submitPendingReview.bind(github),
      addPendingReviewThread: github.addPendingReviewThread.bind(github),
    } as never,
    now,
    new ReviewOperationCoordinator(),
    new TracingRecentWriteJournal(trace, "stored"),
  );
  return service;
}

/** Where the durable intent and the transport call fall in one flow's trace. */
function ordering(trace: Trace) {
  return {
    intent: trace.findIndex((entry) => entry === "intent:WriteInFlight"),
    http: trace.findIndex((entry) => entry.startsWith("http:")),
  };
}

describe("the HTTP transport is reached only after the intent is persisted", () => {
  it("persists intent before a REST write leaves for GitHub", async () => {
    const trace: Trace = [];

    await pendingReviewOverHttp(trace).submit({
      profileId,
      reviewId,
      expected,
      event: "COMMENT",
      summaryBody: "summary",
    });

    const { intent, http } = ordering(trace);
    expect(trace).toContain(
      "http:api POST repos/:owner/:repo/pulls/:n/reviews/:n/events",
    );
    expect(intent).toBeGreaterThanOrEqual(0);
    expect(intent).toBeLessThan(http);
  });

  it("persists intent before a mutation leaves for GitHub", async () => {
    const trace: Trace = [];

    await pendingReviewOverHttp(trace).addThread({
      profileId,
      reviewId,
      expected,
      anchor,
      body: "note",
      pendingReviewNodeId: reviewNodeId,
    });

    const { intent, http } = ordering(trace);
    expect(trace).toContain("http:api graphql addPullRequestReviewThread");
    expect(intent).toBeGreaterThanOrEqual(0);
    expect(intent).toBeLessThan(http);
  });
});
