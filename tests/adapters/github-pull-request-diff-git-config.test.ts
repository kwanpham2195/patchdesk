import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CommandRunner } from "../../src/adapters/github/command-runner";
import { createFetchedDiffRefs } from "../../src/adapters/github/github-adapter";
import { parseAbsolutePath, parseGitSha } from "../../src/domain/ids";
import { orderedTransport } from "./github-transport-doubles";
import {
  mustParse,
  pr,
  profile,
  testAdapter,
} from "./github-adapter-test-support";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** Runs git for fixture setup only; the adapter runs git through the production command runner. */
function git(cwd: string, ...args: ReadonlyArray<string>): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();
}

const lines = (fifth: string): string =>
  ["one", "two", "three", "four", fifth, "six", "seven", "eight"]
    .map((line) => `${line}\n`)
    .join("");

describe("GitHubAdapter pull request diff from managed refs", () => {
  it("writes a/ and b/ paths, three context lines, raw content, and no colour whatever the repository's diff config says", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchdesk-pr-diff-config-"));
    roots.push(root);
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    git(root, "config", "diff.noprefix", "true");
    git(root, "config", "color.diff", "always");
    git(root, "config", "diff.context", "0");
    git(root, "config", "diff.shout.textconv", "awk '{ print toupper($0) }'");
    await writeFile(join(root, ".gitattributes"), "*.txt diff=shout\n");
    await writeFile(join(root, "tracked.txt"), lines("five"));
    git(root, "add", ".gitattributes", "tracked.txt");
    git(root, "commit", "-q", "-m", "base");
    const baseSha = git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "tracked.txt"), lines("changed five"));
    git(root, "commit", "-q", "-am", "head");
    const headSha = git(root, "rev-parse", "HEAD");
    git(root, "update-ref", "refs/patchdesk/base", baseSha);
    git(root, "update-ref", "refs/patchdesk/head", headSha);

    const diff = await testAdapter(
      orderedTransport([]),
      new CommandRunner(),
    ).getPullRequestDiff({
      profile,
      pr,
      fetchedRefs: mustParse(
        createFetchedDiffRefs({
          repositoryPath: mustParse(parseAbsolutePath(root)),
          baseRef: "refs/patchdesk/base",
          headRef: "refs/patchdesk/head",
          baseSha: mustParse(parseGitSha(baseSha)),
          headSha: mustParse(parseGitSha(headSha)),
        }),
      ),
    });

    if (diff._tag !== "ok") throw new Error("Expected the diff to be read");
    expect(diff.value).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(diff.value).toContain("+++ b/tracked.txt");
    expect(diff.value).toContain("@@ -2,7 +2,7 @@");
    expect(diff.value).toContain("+changed five\n");
    expect(diff.value).not.toContain("\u001b");
  });
});
