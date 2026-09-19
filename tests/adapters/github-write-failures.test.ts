import { describe, expect, it } from "vitest";

import {
  CommandRunner,
  type CommandExecution,
  type CommandExecutor,
  type CommandRequest,
} from "../../src/adapters/github/command-runner";
import { writeFailure } from "../../src/adapters/github/github-write-failures";
import type { GitHubWriteFailure } from "../../src/domain/github-write";
import type { ForbiddenReason } from "../../src/domain/github-forbidden-reason";

/**
 * A forbidden write must carry its specific ForbiddenReason and land in a
 * dedicated "forbidden" category — never collapse into the generic
 * "unavailable" category a transient network blip also produces (the
 * write-side counterpart to plan 009's read-side fix; see
 * docs/adr/0024-explain-forbidden-github-reads.md).
 */
describe("writeFailure — CommandForbidden", () => {
  const reasons: ReadonlyArray<ForbiddenReason> = [
    "ip_allow_list",
    "saml",
    "insufficient_scopes",
    "unknown",
  ];

  it.each(reasons)(
    "classifies a forbidden write with reason %s as category 'forbidden', not 'unavailable'",
    (reason) => {
      const failure = writeFailure({ _tag: "CommandForbidden", reason });
      expect(failure._tag).toBe("GitHubWriteFailure");
      expect(failure.category).toBe("forbidden");
      expect(failure.category).not.toBe("unavailable");
      expect(failure.reason).toBe(reason);
    },
  );

  it("gives each forbidden reason its own message, not one generic sentence reused for all four", () => {
    const messages = new Set(
      reasons.map(
        (reason) => writeFailure({ _tag: "CommandForbidden", reason }).message,
      ),
    );
    expect(messages.size).toBe(reasons.length);
  });

  it("never repeats GitHub's raw stdout/stderr text in the message", () => {
    const failure = writeFailure({
      _tag: "CommandForbidden",
      reason: "ip_allow_list",
    });
    // The message is authored copy, not a passthrough of GitHub's own wording.
    expect(failure.message).not.toMatch(/authorization credentials/i);
  });

  it("still classifies every other CommandFailure tag in its own category", () => {
    expect(
      writeFailure({ _tag: "CommandAuthenticationRequired" }).category,
    ).toBe("auth");
    expect(writeFailure({ _tag: "CommandRateLimited" }).category).toBe(
      "rate_limited",
    );
    expect(writeFailure({ _tag: "CommandPendingReview" }).category).toBe(
      "pending_review",
    );
    // A tag that carries no refusal status keeps the intent (issue #288).
    expect(writeFailure({ _tag: "CommandFailed" }).category).toBe(
      "unavailable",
    );
    expect(writeFailure({ _tag: "CommandTimedOut" }).category).toBe(
      "unavailable",
    );
  });
});

class FakeCommandExecutor implements CommandExecutor {
  constructor(private readonly execution: CommandExecution) {}

  execute(_input: CommandRequest): Promise<CommandExecution> {
    return Promise.resolve(this.execution);
  }
}

/**
 * Drives one `gh` failure through the real classifier and the real write
 * mapping, so each case below asserts the whole path a write takes rather
 * than a hand-written CommandFailure tag.
 */
async function writeCategory(
  stdout: string,
  stderr: string,
): Promise<GitHubWriteFailure["category"]> {
  const result = await new CommandRunner(
    new FakeCommandExecutor({ _tag: "Exited", exitCode: 1, stdout, stderr }),
  ).runText({ argv: ["gh"], timeoutMs: 1_000 });
  if (result._tag !== "err") throw new Error("expected a failed execution");
  return writeFailure(result.error).category;
}

/**
 * `rejected` removes the write intent, which is only safe when GitHub refused
 * the request and nothing happened (ADR 0035). A server error says nothing
 * about whether the mutation landed, so it has to keep the Review locked for
 * reconciliation instead (issue #288).
 */
describe("writeFailure — a failure GitHub did not refuse", () => {
  const serverErrors = [
    "gh: Internal Server Error (HTTP 500)",
    "gh: Bad Gateway (HTTP 502)",
    "gh: Service Unavailable (HTTP 503)",
    "gh: Gateway Timeout (HTTP 504)",
  ];

  it.each(serverErrors)("classifies %s as unavailable", async (stderr) => {
    await expect(writeCategory("", stderr)).resolves.toBe("unavailable");
  });

  it.each(serverErrors)(
    "classifies %s as unavailable from the response body alone",
    async (stderr) => {
      const status = /\(HTTP (\d{3})\)/.exec(stderr)?.[1];
      const body = JSON.stringify({ message: "Server Error", status });
      await expect(writeCategory(body, "")).resolves.toBe("unavailable");
    },
  );

  const unrecognized = [
    "gh: I'm a teapot (HTTP 418)",
    "gh: Network Connect Timeout Error (HTTP 599)",
    "gh: something totally unrecognized happened",
    "error connecting to github.com\ncheck your internet connection",
  ];

  it.each(unrecognized)("does not report %s as a rejection", async (stderr) => {
    await expect(writeCategory("", stderr)).resolves.not.toBe("rejected");
  });

  it("classifies a 5xx whose status never reached stderr as unavailable", async () => {
    await expect(writeCategory("", "gh: Bad Gateway")).resolves.toBe(
      "unavailable",
    );
  });

  it("does not report a GraphQL transport failure as a rejection", async () => {
    const stderr =
      "error connecting to api.github.com\ncheck your internet connection";
    await expect(writeCategory("", stderr)).resolves.toBe("unavailable");
  });

  it("does not report a GraphQL server error entry as a rejection", async () => {
    const body = JSON.stringify({
      data: null,
      errors: [{ type: "INTERNAL", message: "Something went wrong." }],
    });
    await expect(writeCategory(body, "")).resolves.toBe("unavailable");
  });
});

/** Widening recovery must not flatten the answers GitHub gives deterministically. */
describe("writeFailure — a failure GitHub did refuse", () => {
  const refusals: ReadonlyArray<
    readonly [string, GitHubWriteFailure["category"]]
  > = [
    ["gh: Bad credentials (HTTP 401)", "auth"],
    ["gh: Resource not accessible by integration (HTTP 403)", "forbidden"],
    [
      "gh: You have exceeded a secondary rate limit. (HTTP 429)",
      "rate_limited",
    ],
  ];

  it.each(refusals)("classifies %s as %s", async (stderr, category) => {
    await expect(writeCategory("", stderr)).resolves.toBe(category);
  });

  it("keeps the one-pending-review-per-user refusal in its own category", async () => {
    const body = JSON.stringify({
      message:
        "You have 1 pending review per pull request. Submit or discard your pending review before submitting another.",
      status: "422",
    });
    await expect(writeCategory(body, "")).resolves.toBe("pending_review");
  });
});
