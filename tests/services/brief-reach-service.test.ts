import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CommandFailure,
  CommandRequest,
} from "../../src/adapters/github/command-runner";
import { PatchdeskPaths } from "../../src/adapters/storage/patchdesk-paths";
import {
  parseReviewSessionId,
  parseWorkspaceProfileId,
} from "../../src/domain/ids";
import { err, ok, type Result } from "../../src/domain/result";
import { computeBriefReach } from "../../src/services/brief-reach-service";

const roots: string[] = [];
const must = <T>(value: Result<T, unknown>): T => {
  if (value._tag === "ok") return value.value;
  throw new Error("fixture value is invalid");
};
const profileId = must(parseWorkspaceProfileId("cfw"));
const headSha = "a".repeat(40);
const sessionId = must(
  parseReviewSessionId(
    "github.com__centraldigital__patchdesk__pr-42__sha-aaaaaaaa__base-bbbbbbbb__aaaaaaaaaaaa",
  ),
);

const PATCH = [
  "diff --git a/src/adapters/writer.ts b/src/adapters/writer.ts",
  "--- a/src/adapters/writer.ts",
  "+++ b/src/adapters/writer.ts",
  "@@ -1,2 +1,2 @@",
  "-export function updateComment(id: string) {",
  "+export function updateThreadComment(id: string) {",
  " }",
  "",
].join("\n");

/** One `git` invocation the service made, and the reply a test stands in for it. */
type GitReply = Result<string, CommandFailure>;

const runner = (reply: (argv: ReadonlyArray<string>) => GitReply) => {
  const calls: Array<ReadonlyArray<string>> = [];
  return {
    calls,
    runText: async (input: CommandRequest): Promise<GitReply> => {
      calls.push(input.argv);
      return reply(input.argv);
    },
  };
};

/** The grep line shape `git grep --count` prints: `<rev>:<path>:<count>`. */
const grepLine = (path: string, count: number) =>
  `${headSha}:${path}:${String(count)}\n`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "patchdesk-brief-reach-"));
  roots.push(root);
  const paths = PatchdeskPaths.forTest(root);
  const worktree = paths.worktreeDirectory(profileId, sessionId);
  await mkdir(worktree, { recursive: true });
  return { paths, worktree, root };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("computeBriefReach", () => {
  it("counts caller files outside the pull request and leaves the diff's own out", async () => {
    const { paths, worktree } = await fixture();
    const fake = runner((argv) => {
      if (argv.includes("rev-parse")) return ok(`${headSha}\n`);
      if (argv.includes("updateThreadComment"))
        return ok(
          grepLine("src/adapters/writer.ts", 3) +
            grepLine("src/main/local-api.ts", 2) +
            grepLine("src/main/routes/conversation-routes.ts", 1),
        );
      return ok(grepLine("src/main/local-api.ts", 1));
    });

    const outcome = await computeBriefReach({
      profileId,
      sessionId,
      worktree,
      headSha,
      patch: PATCH,
      symbols: ["updateThreadComment"],
      paths,
      runner: fake,
    });

    expect(outcome).toMatchObject({
      _tag: "ok",
      value: {
        method: "text_match",
        hop: 1,
        symbols: [
          {
            name: "updateThreadComment",
            outsideCallerFiles: 2,
            outsidePaths: [
              "src/main/local-api.ts",
              "src/main/routes/conversation-routes.ts",
            ],
            insidePR: true,
          },
        ],
        // `updateComment` is removed by the patch and still named elsewhere.
        removedStillReferenced: [
          { name: "updateComment", paths: ["src/main/local-api.ts"] },
        ],
      },
    });
    // The service searches the resolved real path, never the candidate it was handed.
    expect(fake.calls[1]).toEqual([
      "git",
      "--no-replace-objects",
      "-C",
      await realpath(worktree),
      "grep",
      "--fixed-strings",
      "--word-regexp",
      "--count",
      "-e",
      "updateThreadComment",
      headSha,
    ]);
  });

  it("reads a silent nonzero exit as no match rather than a failure", async () => {
    const { paths, worktree } = await fixture();
    const outcome = await computeBriefReach({
      profileId,
      sessionId,
      worktree,
      headSha,
      patch: PATCH,
      symbols: ["updateThreadComment"],
      paths,
      runner: runner((argv) =>
        argv.includes("rev-parse")
          ? ok(`${headSha}\n`)
          : err({ _tag: "CommandFailed", stderr: "" }),
      ),
    });

    expect(outcome).toMatchObject({
      _tag: "ok",
      value: {
        symbols: [
          {
            name: "updateThreadComment",
            outsideCallerFiles: 0,
            insidePR: false,
          },
        ],
        removedStillReferenced: [],
      },
    });
  });

  it("reports the block unavailable when the search itself errors", async () => {
    const { paths, worktree } = await fixture();
    expect(
      await computeBriefReach({
        profileId,
        sessionId,
        worktree,
        headSha,
        patch: PATCH,
        symbols: ["updateThreadComment"],
        paths,
        runner: runner((argv) =>
          argv.includes("rev-parse")
            ? ok(`${headSha}\n`)
            : err({ _tag: "CommandFailed", stderr: "fatal: bad object" }),
        ),
      }),
    ).toEqual({ _tag: "unavailable", reason: "search_failed" });
  });

  it("reports the block unavailable when the search times out", async () => {
    const { paths, worktree } = await fixture();
    expect(
      await computeBriefReach({
        profileId,
        sessionId,
        worktree,
        headSha,
        patch: PATCH,
        symbols: ["updateThreadComment"],
        paths,
        runner: runner((argv) =>
          argv.includes("rev-parse")
            ? ok(`${headSha}\n`)
            : err({ _tag: "CommandTimedOut" }),
        ),
      }),
    ).toEqual({ _tag: "unavailable", reason: "timed_out" });
  });

  it("refuses a worktree outside the profile's own worktree directory", async () => {
    const { paths, root } = await fixture();
    const outside = join(root, "elsewhere");
    await mkdir(outside, { recursive: true });
    const fake = runner(() => ok(`${headSha}\n`));

    expect(
      await computeBriefReach({
        profileId,
        sessionId,
        worktree: outside,
        headSha,
        patch: PATCH,
        symbols: ["updateThreadComment"],
        paths,
        runner: fake,
      }),
    ).toEqual({ _tag: "unavailable", reason: "worktree_unavailable" });
    expect(fake.calls).toEqual([]);
  });

  it("refuses a worktree that no longer stands at the run's revision", async () => {
    const { paths, worktree } = await fixture();
    expect(
      await computeBriefReach({
        profileId,
        sessionId,
        worktree,
        headSha,
        patch: PATCH,
        symbols: ["updateThreadComment"],
        paths,
        runner: runner(() => ok(`${"c".repeat(40)}\n`)),
      }),
    ).toEqual({ _tag: "unavailable", reason: "head_mismatch" });
  });
});
