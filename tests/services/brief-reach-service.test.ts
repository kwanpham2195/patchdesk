import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
const profileId = must(parseWorkspaceProfileId("acme"));
const headSha = "a".repeat(40);
const sessionId = must(
  parseReviewSessionId(
    "github.com__octo-org__patchdesk__pr-42__sha-aaaaaaaa__base-bbbbbbbb__aaaaaaaaaaaa",
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

/** Adds `updateThreadComment` and removes nothing, so it is the one counted name. */
const ADDED_PATCH = [
  "diff --git a/src/adapters/writer.ts b/src/adapters/writer.ts",
  "--- a/src/adapters/writer.ts",
  "+++ b/src/adapters/writer.ts",
  "@@ -1,1 +1,2 @@",
  "+export function updateThreadComment(id: string) {",
  " }",
  "",
].join("\n");

/** One `git` invocation the service made, and the reply a test stands in for it. */
type GitReply = Result<string, CommandFailure>;

/**
 * A `git` stand-in: `reply` answers with every matching line in the
 * `--line-number` shape, and the fake prints it the way `git grep` would for
 * the flags asked for: `--count` per file, and `--max-count` and literal
 * pathspecs honoured for the sites pass.
 */
const runner = (reply: (argv: ReadonlyArray<string>) => GitReply) => {
  const calls: Array<ReadonlyArray<string>> = [];
  return {
    calls,
    runText: async (input: CommandRequest): Promise<GitReply> => {
      calls.push(input.argv);
      const result = reply(input.argv);
      return result._tag === "ok" && input.argv.includes("grep")
        ? ok(asGrepOutput(input.argv, result.value))
        : result;
    },
  };
};

function asGrepOutput(argv: ReadonlyArray<string>, lines: string): string {
  const records = lines
    .split("\n")
    .filter((record) => record !== "")
    .map((record) => {
      const [location = "", line = "", text = ""] = record.split("\0");
      return { location, line, text };
    });
  if (argv.includes("--count")) {
    const counts = new Map<string, number>();
    for (const { location } of records)
      counts.set(location, (counts.get(location) ?? 0) + 1);
    return [...counts]
      .map(([location, count]) => `${location}\0${String(count)}\n`)
      .join("");
  }
  const literal = argv
    .filter((arg) => arg.startsWith(":(literal)"))
    .map((arg) => `${headSha}:${arg.slice(":(literal)".length)}`);
  const maxCount = Number(
    argv.find((arg) => arg.startsWith("--max-count="))?.split("=")[1] ??
      Infinity,
  );
  const perFile = new Map<string, number>();
  return records
    .filter(({ location }) => {
      if (literal.length > 0 && !literal.includes(location)) return false;
      const seen = (perFile.get(location) ?? 0) + 1;
      perFile.set(location, seen);
      return seen <= maxCount;
    })
    .map(({ location, line, text }) => `${location}\0${line}\0${text}\n`)
    .join("");
}

/** `count` matching lines in the shape `git grep --null --line-number` prints: `<rev>:<path>\0<line>\0<text>`. */
const grepLine = (
  path: string,
  count: number,
  text = "updateThreadComment()",
) =>
  Array.from(
    { length: count },
    (_, index) => `${headSha}:${path}\0${String(index + 1)}\0${text}\n`,
  ).join("");

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
      proposed: [],
      paths,
      runner: fake,
    });

    expect(outcome).toMatchObject({
      _tag: "ok",
      value: {
        method: "text_match",
        hop: 1,
        // `updateComment` is declared on a removed line, so it is counted too.
        symbols: [
          {
            name: "updateComment",
            outsideCallerFiles: 1,
            status: "changed",
          },
          {
            name: "updateThreadComment",
            outsideCallerFiles: 2,
            outsidePaths: [
              "src/main/local-api.ts",
              "src/main/routes/conversation-routes.ts",
            ],
            insidePR: true,
            status: "new",
          },
        ],
        // `updateComment` is removed by the patch and still named elsewhere.
        removedStillReferenced: [
          { name: "updateComment", paths: ["src/main/local-api.ts"] },
        ],
      },
    });
    // The service searches the resolved real path, never the candidate it was handed.
    expect(fake.calls[2]).toEqual([
      "git",
      "--no-replace-objects",
      "-C",
      await realpath(worktree),
      "grep",
      "--fixed-strings",
      "--word-regexp",
      "--count",
      "--null",
      "-e",
      "updateThreadComment",
      headSha,
      "--",
      ":(exclude)*.md",
      ":(exclude)*.mdx",
      ":(exclude)*.txt",
      ":(exclude)*.rst",
      ":(exclude)docs/",
    ]);
    // The sites pass reads only the outside files the count found, a bounded number of lines each.
    expect(
      fake.calls.find(
        (argv) =>
          argv.includes("--line-number") &&
          argv.includes("updateThreadComment"),
      ),
    ).toEqual(
      expect.arrayContaining([
        "--max-count=30",
        ":(literal)src/main/local-api.ts",
        ":(literal)src/main/routes/conversation-routes.ts",
      ]),
    );
  });

  it("counts an existing export whose body the patch changes, with its outside mentions", async () => {
    const { paths, worktree } = await fixture();
    const servicePath = "src/services/review-refresh-service.ts";
    await mkdir(join(worktree, "src/services"), { recursive: true });
    await writeFile(
      join(worktree, servicePath),
      [
        "export class ReviewRefreshService {",
        "  async refresh(id: string) {",
        "    return this.load(id, { fresh: true });",
        "  }",
        "}",
      ].join("\n"),
    );
    const bodyOnly = [
      `diff --git a/${servicePath} b/${servicePath}`,
      `--- a/${servicePath}`,
      `+++ b/${servicePath}`,
      "@@ -3 +3 @@",
      "-    return this.load(id);",
      "+    return this.load(id, { fresh: true });",
      "",
    ].join("\n");

    const outcome = await computeBriefReach({
      profileId,
      sessionId,
      worktree,
      headSha,
      patch: bodyOnly,
      proposed: [],
      paths,
      runner: runner((argv) => {
        if (argv.includes("rev-parse")) return ok(`${headSha}\n`);
        if (argv.includes("ReviewRefreshService"))
          return ok(
            grepLine(servicePath, 1, "export class ReviewRefreshService {") +
              grepLine(
                "src/main/local-api-container.ts",
                1,
                "  const refresh = new ReviewRefreshService(dependencies);",
              ),
          );
        return err({ _tag: "CommandFailed", stderr: "" });
      }),
    });

    expect(outcome).toMatchObject({
      _tag: "ok",
      value: {
        symbols: [
          {
            name: "ReviewRefreshService",
            status: "changed",
            insidePR: true,
            outsideCallerFiles: 1,
            outsidePaths: ["src/main/local-api-container.ts"],
            mentions: [
              {
                path: "src/main/local-api-container.ts",
                line: 1,
                kind: "call",
              },
            ],
          },
        ],
      },
    });
  });

  it("records each outside mention's line, kind, and enclosing declaration", async () => {
    const { paths, worktree } = await fixture();
    const caller = [
      'import { updateThreadComment } from "../adapters/writer";',
      "",
      "export class ConversationRoutes {",
      "  async reply(id: string): Promise<void> {",
      "    await updateThreadComment(id);",
      "  }",
      "}",
    ];
    await mkdir(join(worktree, "src/main"), { recursive: true });
    await writeFile(
      join(worktree, "src/main/conversation-routes.ts"),
      caller.join("\n"),
    );
    const matched = (line: number) =>
      `${headSha}:src/main/conversation-routes.ts\0${String(line)}\0${caller[line - 1] ?? ""}\n`;

    const outcome = await computeBriefReach({
      profileId,
      sessionId,
      worktree,
      headSha,
      patch: ADDED_PATCH,
      proposed: [],
      paths,
      runner: runner((argv) => {
        if (argv.includes("rev-parse")) return ok(`${headSha}\n`);
        if (argv.includes("updateThreadComment"))
          return ok(matched(1) + matched(5));
        return err({ _tag: "CommandFailed", stderr: "" });
      }),
    });

    expect(outcome).toMatchObject({
      _tag: "ok",
      value: {
        symbols: [
          {
            name: "updateThreadComment",
            outsideCallerFiles: 1,
            mentionCount: 2,
            // Calls are kept and listed before imports.
            mentions: [
              {
                path: "src/main/conversation-routes.ts",
                line: 5,
                kind: "call",
                enclosing: "ConversationRoutes.reply",
              },
              {
                path: "src/main/conversation-routes.ts",
                line: 1,
                kind: "import",
              },
            ],
          },
        ],
      },
    });
    const [symbol] = outcome._tag === "ok" ? outcome.value.symbols : [];
    expect(symbol?.mentions?.[1]?.enclosing).toBeUndefined();
  });

  it("stores up to twenty outside paths and thirty mention sites per name and keeps the true counts", async () => {
    const { paths, worktree } = await fixture();
    const outsidePaths = Array.from(
      { length: 25 },
      (_, index) => `src/services/caller-${String(index)}.ts`,
    );
    const outcome = await computeBriefReach({
      profileId,
      sessionId,
      worktree,
      headSha,
      patch: ADDED_PATCH,
      proposed: [],
      paths,
      runner: runner((argv) =>
        argv.includes("rev-parse")
          ? ok(`${headSha}\n`)
          : ok(outsidePaths.map((path) => grepLine(path, 2)).join("")),
      ),
    });

    expect(outcome).toMatchObject({
      _tag: "ok",
      value: {
        symbols: [
          {
            name: "updateThreadComment",
            outsideCallerFiles: 25,
            outsidePaths: outsidePaths.slice(0, 20),
            mentionCount: 50,
          },
        ],
      },
    });
    const [symbol] = outcome._tag === "ok" ? outcome.value.symbols : [];
    expect(symbol?.mentions).toHaveLength(30);
  });

  it("keeps the counts when the mention sites overflow the runner's output limit", async () => {
    const { paths, worktree } = await fixture();
    const outcome = await computeBriefReach({
      profileId,
      sessionId,
      worktree,
      headSha,
      patch: ADDED_PATCH,
      proposed: [],
      paths,
      runner: runner((argv) => {
        if (argv.includes("rev-parse")) return ok(`${headSha}\n`);
        // CommandRunner reports output past its 2 MiB limit as CommandFailed with no stderr.
        if (argv.includes("--line-number"))
          return err({ _tag: "CommandFailed" });
        return ok(
          grepLine("src/main/local-api.ts", 3) +
            grepLine("dist/bundle.min.js", 1),
        );
      }),
    });

    expect(outcome).toMatchObject({
      _tag: "ok",
      value: {
        symbols: [
          {
            name: "updateThreadComment",
            outsideCallerFiles: 2,
            outsidePaths: ["src/main/local-api.ts", "dist/bundle.min.js"],
            mentionCount: 4,
            mentions: [],
          },
        ],
      },
    });
  });

  it("excludes prose from the caller count: a Markdown mention is not a caller", async () => {
    const { paths, worktree } = await fixture();
    const fake = runner((argv) => {
      if (argv.includes("rev-parse")) return ok(`${headSha}\n`);
      // A test double that honors the pathspec: the `.md` hit is filtered out
      // before it ever reaches `matchedPaths`, same as real `git grep` would.
      const excludeMd = argv.includes(":(exclude)*.md");
      const lines =
        grepLine("src/main/local-api.ts", 2) +
        (excludeMd ? "" : grepLine("docs/findings/reach.md", 1));
      return ok(lines);
    });

    const outcome = await computeBriefReach({
      profileId,
      sessionId,
      worktree,
      headSha,
      patch: ADDED_PATCH,
      proposed: [],
      paths,
      runner: fake,
    });

    expect(fake.calls[1]).toEqual(
      expect.arrayContaining([
        "--",
        ":(exclude)*.md",
        ":(exclude)*.mdx",
        ":(exclude)*.txt",
        ":(exclude)*.rst",
        ":(exclude)docs/",
      ]),
    );
    expect(outcome).toMatchObject({
      _tag: "ok",
      value: {
        symbols: [
          {
            name: "updateThreadComment",
            outsideCallerFiles: 1,
            outsidePaths: ["src/main/local-api.ts"],
          },
        ],
      },
    });
  });

  it("reads a silent nonzero exit as no match rather than a failure", async () => {
    const { paths, worktree } = await fixture();
    const outcome = await computeBriefReach({
      profileId,
      sessionId,
      worktree,
      headSha,
      patch: PATCH,
      proposed: [],
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
          { name: "updateComment", outsideCallerFiles: 0, insidePR: false },
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
        proposed: [],
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
        proposed: [],
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
        proposed: [],
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
        proposed: [],
        paths,
        runner: runner(() => ok(`${"c".repeat(40)}\n`)),
      }),
    ).toEqual({ _tag: "unavailable", reason: "head_mismatch" });
  });
});
